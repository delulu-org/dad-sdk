/**
 * Public-domain / freely-licensed test fixtures used by `dad test` and the
 * `dad dev` sample requests.
 *
 * These titles are legally safe to request from any addon, anywhere - no
 * copyrighted content is ever probed:
 * - The Blender Foundation open movies (Elephants Dream, Big Buck Bunny,
 *   Sintel, Tears of Steel) are released under CC-BY - free to stream,
 *   copy, and redistribute.
 * - Night of the Living Dead (1968) is in the US public domain.
 * - The Beverly Hillbillies (1962) - classic sitcom whose episodes fell into
 *   the US public domain for lack of copyright renewal; widely distributed
 *   as public-domain television.
 *
 * TMDB IDs verified against the TMDB movie/TV pages.
 */

export interface DadTestFixture {
  title: string;
  media_type: 'movie' | 'tv';
  tmdb_id: number;
  s?: number;
  e?: number;
}

export const DAD_TEST_FIXTURES: DadTestFixture[] = [
  { title: 'Elephants Dream (2006)', media_type: 'movie', tmdb_id: 9761 },
  { title: 'Big Buck Bunny (2008)', media_type: 'movie', tmdb_id: 10378 },
  { title: 'Sintel (2010)', media_type: 'movie', tmdb_id: 45745 },
  { title: 'Tears of Steel (2012)', media_type: 'movie', tmdb_id: 133701 },
  { title: 'Night of the Living Dead (1968)', media_type: 'movie', tmdb_id: 10331 },
  { title: 'The Beverly Hillbillies (1962)', media_type: 'tv', tmdb_id: 1930, s: 1, e: 1 },
];