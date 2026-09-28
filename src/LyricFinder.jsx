import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Search, Loader } from 'lucide-react';
import { requestLyrics, watchSong } from './lib/cloudMixes.js';

// If the fetchLyrics function hasn't touched the song by now, it's most
// likely not deployed (or the emulator isn't running functions).
const RESPONSE_TIMEOUT_MS = 45_000;

const STATUS_TEXT = {
  requesting: 'Looking up lyrics…',
  fetching: 'Looking up lyrics…',
  not_found: 'No lyrics found for that song. Paste them below instead.',
  missing_info: 'Enter both an artist and a song title.',
  error: 'The lyrics service had a problem. Try again, or paste them below.',
  timeout: 'No response from the lyrics function. Is it deployed?',
};

const ERROR_STATUSES = new Set(['not_found', 'missing_info', 'error', 'timeout']);

/* =========================================================================
   Artist + title → lyrics, via the fetchLyrics Cloud Function.
   Creating a users/{uid}/songs doc triggers the function; we then watch that
   doc until it reports a final lyricsStatus and hand the song to onFound,
   which returns a short message describing what it did with the lines.
   ========================================================================= */
export default function LyricFinder({ user, audioDuration, inputClassName, buttonClassName, onFound }) {
  const [artist, setArtist] = useState('');
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState(null); // null | requesting | fetching | ready | not_found | …
  const [resultText, setResultText] = useState(''); // onFound's message, shown once status is 'ready'
  const unsubscribeRef = useRef(null);
  const timeoutRef = useRef(null);
  // The song listener outlives the render that started it; call the latest
  // onFound so it sees the editor's current blocks/nextId, not the ones from
  // when the button was clicked.
  const onFoundRef = useRef(onFound);
  useLayoutEffect(() => {
    onFoundRef.current = onFound;
  });

  const stopWatching = () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    clearTimeout(timeoutRef.current);
  };

  useEffect(() => stopWatching, []); // clean up on unmount

  const busy = status === 'requesting' || status === 'fetching';

  const handleFind = async () => {
    const a = artist.trim();
    const t = title.trim();
    if (!user || busy) return;
    if (!a || !t) {
      setStatus('missing_info');
      return;
    }

    stopWatching();
    setStatus('requesting');
    try {
      const songId = await requestLyrics(user.uid, a, t, audioDuration);
      timeoutRef.current = setTimeout(() => {
        stopWatching();
        setStatus('timeout');
      }, RESPONSE_TIMEOUT_MS);

      unsubscribeRef.current = watchSong(
        user.uid,
        songId,
        (song) => {
          if (!song?.lyricsStatus) return; // function hasn't picked it up yet
          if (song.lyricsStatus === 'fetching') {
            setStatus('fetching');
            return;
          }
          stopWatching();
          setStatus(song.lyricsStatus);
          if (song.lyricsStatus === 'ready') {
            setResultText(onFoundRef.current(song, { artist: a, title: t }) ?? '');
            setArtist('');
            setTitle('');
          }
        },
        () => {
          stopWatching();
          setStatus('error');
        },
      );
    } catch (err) {
      console.error('Requesting lyrics failed', err);
      setStatus('error');
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') handleFind();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2.5 items-center flex-wrap">
        <input
          className={`${inputClassName} w-44`}
          placeholder="Artist"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!user}
        />
        <input
          className={`${inputClassName} w-56`}
          placeholder="Song title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!user}
        />
        <button
          className={buttonClassName}
          onClick={handleFind}
          disabled={!user || busy}
          title={user ? 'Fetch this song\'s lyrics into the bank' : 'Sign in to look up lyrics'}
        >
          {busy ? <Loader size={16} className="animate-spin" /> : <Search size={16} />}
          <span>Find lyrics</span>
        </button>
        {!user && <span className="text-xs text-text-dim">Sign in to look up lyrics by artist and title.</span>}
      </div>
      {status === 'ready' && resultText && <div className="text-xs text-text-dim">{resultText}</div>}
      {status && STATUS_TEXT[status] && (
        <div className={`text-xs ${ERROR_STATUSES.has(status) ? 'text-[#E14F84]' : 'text-text-dim'}`}>{STATUS_TEXT[status]}</div>
      )}
    </div>
  );
}
