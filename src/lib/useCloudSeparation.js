// Drives one cloud separation at a time from the editor: check whether
// this exact file was separated before (reuse it if so) → otherwise upload
// → wait for the Cloud Run job → download both stems → hand them to onReady.
//
// job = null | { fileName, phase, progress, error, reused }
//   phase: checking → [uploading → queued → starting → running →] downloading → done | error
//   progress: 0..1 within the current phase (uploading / running only)
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hashFile, findReadySeparation, startSeparation, watchSeparation, downloadStems } from './cloudSeparations.js';

export function useCloudSeparation(user, onReady) {
  const [job, setJob] = useState(null);
  const unsubscribeRef = useRef(null);
  // The job outlives the render that started it; call the latest onReady.
  const onReadyRef = useRef(onReady);
  useLayoutEffect(() => {
    onReadyRef.current = onReady;
  });

  const stopWatching = () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  };

  useEffect(() => () => unsubscribeRef.current?.(), []);

  // Signing out ends access to the doc, so drop any job in progress.
  const uid = user?.uid;
  useEffect(() => {
    if (uid) return;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, [uid]);

  const start = useCallback(async (file) => {
    if (!uid) return;
    stopWatching();
    const update = (patch) => setJob((prev) => ({ ...prev, ...patch }));
    setJob({ fileName: file.name, phase: 'checking', progress: 0, error: null, reused: false });

    const finish = async (sep, reused) => {
      update({ phase: 'downloading', progress: 0, reused });
      try {
        const blobs = await downloadStems(sep);
        onReadyRef.current(blobs, { file, separation: sep });
        update({ phase: 'done', processingSeconds: sep.processingSeconds });
      } catch (err) {
        update({ phase: 'error', error: `Stems are ready but couldn't be downloaded: ${err.message}` });
      }
    };

    try {
      const fileHash = await hashFile(file);
      const existing = await findReadySeparation(uid, fileHash);
      if (existing) {
        await finish(existing, true);
        return;
      }

      update({ phase: 'uploading' });
      const id = await startSeparation(uid, file, fileHash, (progress) => update({ progress }));
      update({ phase: 'queued', progress: 0 });

      unsubscribeRef.current = watchSeparation(
        uid,
        id,
        async (sep) => {
          if (!sep) return;
          if (sep.status === 'error') {
            stopWatching();
            update({ phase: 'error', error: sep.error || 'Separation failed.' });
          } else if (sep.status === 'ready') {
            stopWatching();
            await finish(sep, false);
          } else {
            update({ phase: sep.status, progress: sep.progress ?? 0 });
          }
        },
        (err) => update({ phase: 'error', error: err.message }),
      );
    } catch (err) {
      update({ phase: 'error', error: err.message });
    }
  }, [uid]);

  const dismiss = useCallback(() => {
    stopWatching();
    setJob(null);
  }, []);

  const busy = !!job && !['done', 'error'].includes(job.phase);
  return { job: uid ? job : null, busy: uid ? busy : false, start, dismiss };
}
