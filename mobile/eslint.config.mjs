import expoConfig from "eslint-config-expo/flat/default.js";

// mobile/ never had its own eslint config before — `npx expo lint` was
// silently climbing up to the root project's eslint.config.mjs (ESLint's
// default config-file resolution walks up parent directories when none is
// found locally). That happened to mostly work by accident since the old
// root config's rules were generic enough, but broke outright once the
// root config started excluding "mobile/**" from its own scope (see that
// file's comment) — mobile needs a real config of its own, not an
// accidental dependency on the web app's.
const eslintConfig = [
  ...expoConfig,
  {
    ignores: ["dist/**", "node_modules/**", ".expo/**"],
  },
  {
    // Matches the same downgrade-to-warning treatment as the root config —
    // these screens use `any` extensively for Supabase join-query results,
    // a real cleanup worth doing separately, not blocking here.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Same react-hooks/react-compiler ruleset escalation as the root
    // config's matching comment — eslint-config-expo bundles the same
    // stricter rules, catching the identical
    // `useCallback` + `useEffect(() => load(), [load])` pattern used
    // throughout every screen. Downgraded to warnings for the same reason:
    // real feedback, but a separate refactor across ~40 screens.
    rules: {
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/purity": "warn",
    },
  },
];

export default eslintConfig;
