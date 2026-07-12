/* Team name → national flag. Flags are public-domain SVGs from flagcdn,
 * vendored into web/public/flags/<iso>.svg (see that dir). `flagUrl` returns the
 * asset path or null when we have no flag for that name (caller falls back to an
 * initials blob). Match on a normalised name so "USA", "U.S.A.", "United States"
 * all resolve. Clubs (Arsenal, …) intentionally have no flag → null. */

const NAME_TO_ISO: Record<string, string> = {
  usa: "us", "united states": "us", "united states of america": "us", us: "us",
  belgium: "be",
  portugal: "pt",
  spain: "es",
  brazil: "br",
  serbia: "rs",
  france: "fr",
  poland: "pl",
  argentina: "ar",
  england: "gb-eng",
  germany: "de",
  netherlands: "nl", holland: "nl",
  croatia: "hr",
  uruguay: "uy",
  japan: "jp",
  mexico: "mx",
  canada: "ca",
  morocco: "ma",
  switzerland: "ch",
  colombia: "co",
  ghana: "gh",
  algeria: "dz",
  senegal: "sn",
  "south korea": "kr", "korea republic": "kr", korea: "kr",
  australia: "au",
  denmark: "dk",
  italy: "it",
  ecuador: "ec",
  iran: "ir",
  qatar: "qa",
  "saudi arabia": "sa",
  tunisia: "tn",
  "costa rica": "cr",
  cameroon: "cm",
  wales: "gb-wls",
  scotland: "gb-sct",
  nigeria: "ng",
  egypt: "eg",
  "ivory coast": "ci", "cote d'ivoire": "ci", "côte d'ivoire": "ci",
  norway: "no",
  sweden: "se",
  austria: "at",
  turkey: "tr", "türkiye": "tr", turkiye: "tr",
  ukraine: "ua",
  peru: "pe",
  chile: "cl",
  paraguay: "py",
  "new zealand": "nz",
  greece: "gr",
  hungary: "hu",
};

const norm = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");

/** ISO code for a team name, or null if we don't have one. */
export function flagCode(name: string | undefined | null): string | null {
  if (!name) return null;
  return NAME_TO_ISO[norm(name)] ?? null;
}

/** `/flags/<iso>.svg` for a team, or null (→ caller shows an initials blob). */
export function flagUrl(name: string | undefined | null): string | null {
  const code = flagCode(name);
  return code ? `/flags/${code}.svg` : null;
}

/** Short fallback token for the no-flag blob, e.g. "Portugal" → "POR". */
export function teamInitials(name: string | undefined | null): string {
  if (!name) return "?";
  return name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "?";
}
