import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript", "plugin:jsx-a11y/recommended"),
  {
    ignores: [".next/**", "node_modules/**", "supabase/**"],
  },
  {
    // The pre-existing portal pages (predating this config's introduction)
    // use `any` extensively for Supabase join-query results. Downgraded to
    // a warning rather than fixed wholesale here — that's a real cleanup
    // worth doing, but it's a separate, larger pass across ~40 files, not
    // part of this auth/RBAC hardening pass. New code should still avoid it.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];

export default eslintConfig;
