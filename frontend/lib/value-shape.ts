// Client mirror of valueShape in backend/src/sitemaps/transformDryRun.ts.
//
// KEEP IN SYNC. The dry run computes shapes server-side and the modal renders
// them as checkboxes; this copy exists so the modal can ask "which shape is this
// URL?" about its own preview pool without a round trip — specifically so the
// v1.68 coverage gate can be measured INSIDE the selected shapes. A rule that
// fits the ticked shapes must not be blocked for ignoring the unticked ones,
// which is what the gate would otherwise do the moment anyone narrowed a
// transform.
//
// Same arrangement, and the same reason, as lib/transform-structure.ts and
// lib/structure-filter.ts. A parity test pins it to the backend copy's outputs.

// Digit runs collapse to "9" repeated their own length — that length is the
// whole point, since it is what separates nsn-parts-12191 from nsn-parts-6492
// and what a token-boundary structure filter cannot express. Letter runs
// collapse to a single "a". Everything else (separators) is kept verbatim.
//
// The 12 cap matches the backend: past it a longer run stops producing new
// shapes, which bounds the histogram on pathological numeric ids.
export function valueShape(value: string): string {
  let out = "";
  let index = 0;

  while (index < value.length) {
    const code = value.charCodeAt(index);

    if (code >= 48 && code <= 57) {
      const start = index;

      do {
        index += 1;
      } while (
        index < value.length &&
        value.charCodeAt(index) >= 48 &&
        value.charCodeAt(index) <= 57
      );

      out += "9".repeat(Math.min(index - start, 12));
      continue;
    }

    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      do {
        index += 1;
      } while (
        index < value.length &&
        ((value.charCodeAt(index) >= 65 && value.charCodeAt(index) <= 90) ||
          (value.charCodeAt(index) >= 97 && value.charCodeAt(index) <= 122))
      );

      out += "a";
      continue;
    }

    out += value[index];
    index += 1;
  }

  return out;
}

// The shape of a URL's path, or null when it is not a parseable URL.
export function urlShape(rawUrl: string): string | null {
  try {
    return valueShape(new URL(rawUrl).pathname);
  } catch {
    return null;
  }
}
