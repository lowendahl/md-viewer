/**
 * MD-Viewer observability — thin shim over @compass/observability.
 *
 * Preserves the legacy `installObservability(version)` call signature
 * used in main.js so nothing else needs to change.
 */
const pkg = require('@compass/observability/main');

function installObservability(version) {
  pkg.installObservability({
    appName: 'mdviewer',
    version,
    envVar: 'MDV_TELEMETRY_DIR',
    logFilePrefix: 'events',
  });
}

module.exports = {
  installObservability,
  emit: pkg.emit,
  logPipelineEvent: pkg.logPipelineEvent,
  classify: pkg.classify,
  showFriendlyDialog: pkg.showFriendlyDialog,
  wrapIpc: pkg.wrapIpc,
  readEvents: pkg.readEvents,
  listLogDates: pkg.listLogDates,
  logFilePath: pkg.logFilePath,
  get TELEMETRY_DIR() {
    return pkg.TELEMETRY_DIR;
  },
  get SESSION_ID() {
    return pkg.SESSION_ID;
  },
};
