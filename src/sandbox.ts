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
 * Atomic details for a DOM element returned by Delulu Core's bulk extraction bridge.
 */
export interface CheerioElementDetail {
  /** Unique monotonic identifier for the element within the parsed document. */
  id: string;
  /** Combined text content of the element. */
  text: string;
  /** Outer HTML representation of the element. */
  html: string;
  /** Key-value dictionary of all element attributes (e.g. href, class, data-*). */
  attrs: Record<string, string>;
}

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

  /** Finds descendant elements strictly matching the CSS sub-selector within this selection. */
  find(selector: string): CheerioSelection;

  /**
   * Atomic bulk extraction of all matching elements' IDs, text, HTML, and attributes in a single pass.
   * Up to 10x faster than looping over individual elements across FFI boundaries.
   */
  details(): CheerioElementDetail[];

  /** Immediately follows to the next element sibling in the DOM tree. */
  next(): CheerioSelection;

  /** Immediately navigates to the previous element sibling in the DOM tree. */
  prev(): CheerioSelection;

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

  /**
   * Bulk extracts details for elements matching the CSS selector in a single native pass.
   * Equivalent to `$(selector).details()`.
   */
  details(selector: string): CheerioElementDetail[];
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

export interface CryptoJSAESOptions {
  iv?: any;
  mode?: any;
  padding?: any;
  [key: string]: any;
}

export interface CryptoJSAES {
  encrypt(message: string, key: string | any, options?: CryptoJSAESOptions): any;
  decrypt(ciphertext: string | any, key: string | any, options?: CryptoJSAESOptions): any;
}

export interface CryptoJSEngine {
  MD5(message: string): any;
  SHA1(message: string): any;
  SHA256(message: string): any;
  SHA512(message: string): any;
  HmacMD5(message: string, secret: string): any;
  HmacSHA1(message: string, secret: string): any;
  HmacSHA256(message: string, secret: string): any;
  HmacSHA512(message: string, secret: string): any;
  AES: CryptoJSAES;
  enc: CryptoJSEnc;
  mode: {
    CBC: any;
    ECB: any;
    [key: string]: any;
  };
  pad: {
    Pkcs7: any;
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Native hardware-accelerated cryptography engine available in Delulu Core's QuickJS runtime.
 */
export const CryptoJS: CryptoJSEngine = (typeof globalThis !== 'undefined'
  ? (globalThis as any).CryptoJS
  : undefined) as unknown as CryptoJSEngine;

/**
 * Native Mozilla Servo-backed DOM parser available in Delulu Core's QuickJS runtime.
 */
export const cheerio: CheerioEngine = (typeof globalThis !== 'undefined'
  ? (globalThis as any).cheerio
  : undefined) as unknown as CheerioEngine;

// Ambient global declarations for TypeScript IntelliSense when authoring JS addons
declare global {
  /** Native Mozilla Servo-backed DOM parser (API matches Cheerio load and selections) */
  const cheerio: CheerioEngine;
}
