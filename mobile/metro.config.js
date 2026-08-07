// Monorepo Metro config — lets this Expo app import shared files (notably
// ../types/database.ts, the single hand-maintained source of truth for the
// DB schema) directly from the repo root instead of copying them.
// https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// Watch the repo root too, so edits to ../types/database.ts trigger a refresh.
config.watchFolders = [workspaceRoot];

// Resolve node_modules from both this project and the repo root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
