/**
 * buildEntry — a compile-only entry point for the explorer.
 *
 * Lane 4 ships no route (Lane 3 owns the App.jsx hook and lazy-imports
 * ../index.jsx), so until that lane lands NOTHING in the app graph references
 * this directory and `vite build` would happily report "clean" while never
 * having parsed a line of it. This entry exists so the build actually compiles
 * the surface it is being asked to vouch for:
 *
 *   npx vite build --config <a config whose rollupOptions.input is this file>
 *
 * It is deliberately side-effect free — it imports, touches every module in the
 * directory so none can be tree-shaken away before type/parse errors surface,
 * and mounts nothing.
 */
import AnalyticsExplorer from '../index.jsx';
import ExplorerChart from '../ExplorerChart.jsx';
import { colorForIndex } from '../chartColors.js';
import PresetGrid from '../PresetGrid.jsx';
import SavedReports from '../SavedReports.jsx';
import * as savedReports from '../savedReportsStore.js';
import * as explorerApi from '../explorerApi.js';
import * as reportConfig from '../../reportConfig.js';

// Referenced (not just imported) so nothing is dropped before it is parsed.
export const __compiled = [
  AnalyticsExplorer, ExplorerChart, PresetGrid, SavedReports,
  colorForIndex, savedReports, explorerApi, reportConfig,
].map((m) => typeof m).join(',');
