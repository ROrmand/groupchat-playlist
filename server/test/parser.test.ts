import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseChatText, type ParsedTrackLink } from '../src/domain/ChatTextParser.js';
import { canonicalizeTrack, normalizeTrackText } from '../src/domain/TrackCanonicalizer.js';

test('Swift and TypeScript consume the same parser edge-case fixtures', async () => {
  const fixtures = JSON.parse(await readFile('../Tests/TrackResolverEngineTests/Fixtures/chat-parser.json', 'utf8')) as { input: string; expected: ParsedTrackLink[] }[];
  for (const fixture of fixtures) assert.deepEqual(parseChatText(fixture.input), fixture.expected, fixture.input);
});

test('parser enforces UTF-8 and link count limits', () => {
  assert.throws(() => parseChatText('🔥'.repeat(2049)), { code: 'input_too_long' });
  assert.throws(() => parseChatText('https://youtu.be/dQw4w9WgXcQ '.repeat(65)), { code: 'too_many_links' });
});

test('canonicalizer removes only specified metadata noise and preserves recording variants', () => {
  assert.equal(normalizeTrackText('Beyoncé — Déjà Vu (feat. Guest) [Deluxe Edition] (Remastered 2011)'), 'beyonce deja vu');
  assert.equal(normalizeTrackText('Song (Live) [Acoustic]'), 'song live acoustic');
  assert.equal(normalizeTrackText('日本語の曲'), '日本語の曲');
  const track = canonicalizeTrack({ title: 'Héllo!', artist: 'Artist', album: null, durationMs: 180001, isrc: 'us-aaa-23-00001' });
  assert.equal(track.isrc, 'USAAA2300001');
  assert.equal(track.fallbackDedupKey, 'hello::artist::60::isrc:USAAA2300001');
  const fallback = canonicalizeTrack({ ...track, isrc: null });
  assert.equal(fallback.fallbackDedupKey, 'hello::artist::60');
  for (const durationMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    assert.throws(() => canonicalizeTrack({ ...track, durationMs }), { code: 'invalid_track_metadata' });
  }
  assert.throws(() => canonicalizeTrack({ ...track, title: '!!!' }), { code: 'invalid_track_metadata' });
  assert.throws(() => canonicalizeTrack({ ...track, isrc: 'not an ISRC' }), { code: 'invalid_track_metadata' });
});
