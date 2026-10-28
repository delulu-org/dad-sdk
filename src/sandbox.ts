/**
 * QuickJS Sandbox Environment Typings.
 *
 * Inside Delulu Core's sandboxed QuickJS execution runtime, DOM parsing is
 * backed by the native Rust Mozilla Servo engine (`scraper`, `html5ever`, `selectors`),
 * and cryptography is backed by native hardware-accelerated Rust crypto.
 *
 * These APIs are exposed in the JavaScript runtime under standard, familiar names
 * (`cheerio` and `CryptoJS`) so developers enjoy standard ergonomics with bare-metal speed.
 */

/**
 * A selection of one or more DOM elements parsed by Delulu Core's native Servo engine.
 */
export interface CheerioSelection {
  /** Returns the combined text content of the selected elements. */
  text(): string;

  /** Returns the value of the specified attribute for the first element in the selection. */
  attr(name: string): string | undefined;

  /** Returns the outer HTML of the selected elements. */
  html(): string;

  /** Finds descendant elements matching the CSS sub-selector. */
  find(selector: string): CheerioSelection;

  /** Iterates over each element in the selection. */
  each(callback: (index: number, element: CheerioSelection) => void): CheerioSelection;

  /** Reduces the selection to the first element. */
  first(): CheerioSelection;

  /** Reduces the selection to the last element. */
  last(): CheerioSelection;

  /** Reduces the selection to the element at the specified index. */
  eq(index: number): CheerioSelection;
}

/**
 * jQuery-like callable selection function returned by `cheerio.load(...)`.
 */
export interface CheerioStatic {
  /** Selects DOM elements matching the given CSS selector. */
  (selector: string): CheerioSelection;

  /** Returns the full outer HTML of the parsed document. */
  html(): string;
}

export interface CheerioEngine {
  /**
   * Parses an HTML string using Delulu Core's native Mozilla Servo engine.
   * Returns a `$` function to query and extract elements via CSS selectors.
   */
  load(html: string): CheerioStatic;
}

export interface CryptoJSCodec {
  stringify(wordArray: any): string;
  parse(str: string): any;
}

export interface CryptoJSEnc {
  Utf8: CryptoJSCodec;
  Hex: CryptoJSCodec;
  Base64: CryptoJSCodec;
  Latin1?: CryptoJSCodec;
}

export interface CryptoJSAES {
  encrypt(message: string, key: string, options?: any): any;
  decrypt(ciphertext: string, key: string, options?: any): any;
}

export interface CryptoJSEngine {
  MD5(message: string): any;
  SHA256(message: string): any;
  HmacSHA256(message: string, secret: string): any;
  AES: CryptoJSAES;
  enc: CryptoJSEnc;
  [key: string]: any;
}

// Ambient global declarations for TypeScript IntelliSense when authoring JS addons
declare global {
  /** Native Servo-backed DOM parser (API matches Cheerio load and selections) */
  const cheerio: CheerioEngine;
}
