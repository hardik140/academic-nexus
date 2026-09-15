import eslintConfigNext from "eslint-config-next";
import jsxA11y from "eslint-plugin-jsx-a11y";

// eslint-config-next@16 ships native flat-config arrays directly (no more
// FlatCompat/@eslint/eslintrc bridge needed, and that package is no longer
// even in the dependency tree). eslint-config-next's own "next" entry
// already registers the jsx-a11y plugin itself (re-declaring it under the
// same key errors: "Cannot redefine plugin") — only its recommended *rules*
// are added here, since eslint-plugin-jsx-a11y@6.10.2 doesn't export a
// ready flat config of its own yet.
const eslintConfig = [
  ...eslintConfigNext,
  {
    rules: jsxA11y.configs.recommended.rules,
  },
  {
    // mobile/ has always been linted separately (`cd mobile && npx expo
    // lint`, its own eslint config) — switching the root lint script from
    // `next lint` to a bare `eslint .` (next lint is gone in Next 16)
    // started crawling it too unless excluded here explicitly. .open-next/
    // is the Cloudflare Workers build output (open-next.config.ts/
    // wrangler.jsonc) — bundled/minified build artifacts, not source; a
    // bare `eslint .` crawls into it once it exists and fails outright
    // ("could not find plugin jsx-a11y") rather than just producing
    // findings, since generated files there don't match this config's
    // plugin-registration entry the way real source files do.
    ignores: [".next/**", ".open-next/**", ".wrangler/**", "node_modules/**", "supabase/**", "mobile/**"],
  },
  {
    // Scoped to the same files next/typescript's own entry applies to —
    // an unscoped rules-only block applies to every linted file (including
    // plain .mjs/.js ones), and those don't have the @typescript-eslint
    // plugin registered, which errors rather than silently no-opping.
    files: ["**/*.ts", "**/*.tsx"],
    // The pre-existing portal pages (predating this config's introduction)
    // use `any` extensively for Supabase join-query results. Downgraded to
    // a warning rather than fixed wholesale here — that's a real cleanup
    // worth doing, but it's a separate, larger pass across ~40 files, not
    // part of this auth/RBAC hardening pass. New code should still avoid it.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // The Next.js 16 upgrade's eslint-config-next bundles a much stricter
    // React Hooks/Compiler ruleset than before: react-hooks/exhaustive-deps
    // got escalated from its previous warn-level default to error, and
    // react-hooks/immutability + react-hooks/set-state-in-effect are brand
    // new. All three flag a data-fetching pattern
    // (`const load = useCallback(...); useEffect(() => { load(); }, [load])`)
    // used throughout the portal pages built before this rule existed —
    // legitimate feedback (see https://react.dev/learn/you-might-not-need-an-effect),
    // but rewriting that pattern across ~40 files is a real, separate
    // refactor, not something to fold into a dependency-version merge.
    // Downgraded to warnings for now, same treatment as no-explicit-any
    // above.
    rules: {
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
