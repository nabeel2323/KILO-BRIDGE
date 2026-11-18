"use strict";

import path from "node:path";

const PROHIBITED_PATTERNS: RegExp[] = [
  /(?:^|\/)\.env(?:\..+)?$/i,
  /(?:^|\/)secrets(?:\/|$)/i,
  /(?:^|\/)credentials(?:\/|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /(?:^|\/)id_rsa(?:\.|$|\/)/i,
  /(?:^|\/)bridge\.config\.json$/i,
  /(?:^|\/)data\/kilo-bridge\.sqlite$/i,
];

export function findProhibitedFiles(files: string[]): string[] {
  return files.filter((f) => {
    const normalized = f.replace(/\\/g, "/");
    return PROHIBITED_PATTERNS.some((re) => re.test(normalized));
  });
}

export function isProhibitedFile(file: string): boolean {
  return findProhibitedFiles([file]).length > 0;
}
