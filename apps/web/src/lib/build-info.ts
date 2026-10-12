/**
 * D-636: el commit con que se compiló la web. `next.config.ts` fija en el build
 * `AYR_BUILD_SHA` (de `VERCEL_GIT_COMMIT_SHA`) y `AYR_BUILT_AT`; en local no hay sha y queda
 * «dev». `/version` lo publica y `smoke:prod` lo compara con `main`.
 */
export interface BuildInfo {
  sha: string;
  builtAt: string | null;
}

/** Vacío o solo espacios cuenta como ausente: `next.config.ts` pone `''` sin la variable. */
function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

export function buildInfo(env: Record<string, string | undefined>): BuildInfo {
  return {
    sha: present(env.AYR_BUILD_SHA) ?? 'dev',
    builtAt: present(env.AYR_BUILT_AT),
  };
}
