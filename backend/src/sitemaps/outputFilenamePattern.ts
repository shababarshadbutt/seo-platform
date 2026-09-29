// User-specified output filenames for the sitemap-regenerate wizard's
// generated chunk files. Generalizes uniqueOutputName() (cleaner.ts) — same
// "collision means append a version suffix" idea — from a single desired name
// to a whole numbered BATCH built from one template, e.g. "sitemap-{n}.xml"
// (the default) or "niin/rfq-{n}" (one folder level, extension implied).

const PLACEHOLDER = "{n}";

export const DEFAULT_FILENAME_TEMPLATE = "sitemap-{n}.xml";

export type FilenameTemplateValidation =
  | { ok: true }
  | { ok: false; error: string };

export function validateFilenameTemplate(
  template: string
): FilenameTemplateValidation {
  if (typeof template !== "string" || template.trim() === "") {
    return { ok: false, error: "Filename pattern is required." };
  }

  const trimmed = template.trim();
  const placeholderCount = trimmed.split(PLACEHOLDER).length - 1;

  if (placeholderCount !== 1) {
    return {
      ok: false,
      error: `Filename pattern must contain exactly one ${PLACEHOLDER} placeholder.`
    };
  }

  if (trimmed.startsWith("/")) {
    return { ok: false, error: 'Filename pattern must not start with "/".' };
  }

  if (trimmed.includes("..")) {
    return { ok: false, error: 'Filename pattern must not contain "..".' };
  }

  // Validate the character set with the placeholder substituted for a
  // representative digit, so {n} itself (containing "{" and "}") doesn't fail
  // the safe-characters check.
  if (!/^[a-zA-Z0-9._/-]+$/.test(trimmed.split(PLACEHOLDER).join("1"))) {
    return {
      ok: false,
      error:
        'Filename pattern may only contain letters, numbers, ".", "_", "-" and a single "/".'
    };
  }

  const slashCount = (trimmed.match(/\//g) ?? []).length;

  if (slashCount > 1) {
    return {
      ok: false,
      error: "Filename pattern may include at most one folder level."
    };
  }

  if (slashCount === 1 && trimmed.endsWith("/")) {
    return { ok: false, error: 'Filename pattern must not end with "/".' };
  }

  return { ok: true };
}

// {n} -> the 1-based sequence number, and the extension is always forced to
// exactly one trailing ".xml" — whether or not the template spelled it out
// ("sitemap-{n}.xml" and "niin/rfq-{n}" both produce a valid .xml filename).
export function renderOutputFilename(template: string, n: number): string {
  const withNumber = template.trim().split(PLACEHOLDER).join(String(n));

  return withNumber.toLowerCase().endsWith(".xml")
    ? withNumber
    : `${withNumber}.xml`;
}

export type FilenameBatchResult = {
  template: string;
  filenames: string[];
  renamed: boolean;
};

// Render a whole batch of fileCount filenames from template, and if any of
// them collides with an existing (live, published) filename, back the WHOLE
// batch off together — inserting a "v2"/"v3"/... version marker right before
// {n} — rather than resolving collisions file-by-file, which would leave a
// batch reading "rfq-1, rfq-2, rfq-2-v2, rfq-4" instead of a clean,
// consistently-versioned sequence.
export function pickCollisionFreeTemplate(
  template: string,
  fileCount: number,
  existingFilenames: ReadonlySet<string>
): FilenameBatchResult {
  let candidateTemplate = template.trim();
  let renamed = false;

  for (let version = 2; ; version += 1) {
    const filenames = Array.from({ length: fileCount }, (_, index) =>
      renderOutputFilename(candidateTemplate, index + 1)
    );
    const hasCollision = filenames.some((name) => existingFilenames.has(name));

    if (!hasCollision) {
      return { template: candidateTemplate, filenames, renamed };
    }

    renamed = true;
    candidateTemplate = template
      .trim()
      .split(PLACEHOLDER)
      .join(`v${version}-${PLACEHOLDER}`);
  }
}
