/**
 * ================================================================
 * DRT Operations Hub — Presenter Mode Controller
 * ================================================================
 *
 * PURPOSE
 * -------
 * This file implements "Presenter Mode".
 *
 * Presenter Mode is a fully automated, hands-free mode intended
 * for:
 *   - Boardroom presentations
 *   - Public open houses
 *   - Control room displays
 *   - Large screen demos
 *
 * It automatically cycles through all Durham Region Transit
 * (DRT) service municipalities, showing:
 *   - A map focused on each region
 *   - All live buses currently operating in that region
 *
 * Each region remains on screen for a minimum of 1 minute.
 *
 * ------------------------------------------------
 * RESPONSIBILITIES
 * ------------------------------------------------
 * ✅ Manage region rotation timing
 * ✅ Track presenter state (active / inactive)
 * ✅ Trigger map updates per region
 * ✅ Update presenter UI labels (region name)
 *
 * ❌ Does NOT:
 *    - Fetch data
 *    - Draw map markers
 *    - Filter vehicles itself
 *
 * This controller *orchestrates* Presenter Mode.
 *
 * ================================================================
 */

import { REGIONS } from "./regions.js";

/**
 * ------------------------------------------------
 * CONFIGURATION
 * ------------------------------------------------
 */

/**
 * How long each region should remain visible.
 * Minimum requested: 1 minute.
 *
 * You can safely tune this to:
 *   - 60_000  (1 minute)
 *   - 75_000  (1.25 minutes)
 *   - 90_000  (1.5 minutes)
 *
 * For most presentations, 60–75 seconds is ideal.
 */
const REGION_DISPLAY_DURATION_MS = 60_000;

/**
 * Map animation duration (milliseconds).
 * This controls how long the pan/zoom animation takes
 * when transitioning between regions.
 */
const MAP_TRANSITION_MS = 2000;

/**
 * ------------------------------------------------
 * INTERNAL STATE
 * ------------------------------------------------
 */

/**
 * Index of the currently displayed region
 * within the REGIONS array.
 */
let currentRegionIndex = 0;

/**
 * Holds the ID returned by setInterval().
 * Used to start/stop Presenter Mode safely.
 */
let presenterTimer = null;

/**
 * Indicates whether Presenter Mode is currently active.
 */
let isPresenterActive = false;

/**
 * ------------------------------------------------
 * EXTERNAL HOOKS
 * ------------------------------------------------
 *
 * These functions are expected to be provided
 * by map.js or app.js.
 *
 * Presenter Mode calls these — it does not implement
 * them itself.
 */

/**
 * Zooms the map to a region's bounding box and updates
 * vehicle visibility accordingly.
 *
 * @param {Object} region - Region definition from regions.js
 */
function showRegionOnMap(region) {
  if (!window.presenterMapController) {
    console.warn("Presenter map controller not initialized");
    return;
  }

  window.presenterMapController.showRegion(region, {
    animate: true,
    durationMs: MAP_TRANSITION_MS
  });
}

/**
 * Updates on-screen region title/banner for Presenter Mode.
 *
 * @param {string} regionName - Human-friendly name of region
 */
function updatePresenterBanner(regionName) {
  const banner = document.getElementById("presenter-region-name");
  if (banner) {
    banner.textContent = regionName;
  }
}

/**
 * ------------------------------------------------
 * CORE LOGIC
 * ------------------------------------------------
 */

/**
 * Displays the current region based on currentRegionIndex.
 */
function displayCurrentRegion() {
  const region = REGIONS[currentRegionIndex];
  if (!region) return;

  // Update map view
  showRegionOnMap(region);

  // Update UI banner
  updatePresenterBanner(region.name);

  console.log(
    `[PRESENTER MODE] Showing region: ${region.name}`
  );
}

/**
 * Advances to the next region in the list.
 * Loops back to the start when the end is reached.
 */
function advanceToNextRegion() {
  currentRegionIndex =
    (currentRegionIndex + 1) % REGIONS.length;

  displayCurrentRegion();
}

/**
 * ------------------------------------------------
 * PRESENTER MODE CONTROLS
 * ------------------------------------------------
 */

/**
 * Starts Presenter Mode.
 * Safe to call multiple times — subsequent calls
 * while active will be ignored.
 */
export function startPresenterMode() {
  if (isPresenterActive) {
    console.warn("Presenter Mode already active");
    return;
  }

  console.log("[PRESENTER MODE] Starting");

  isPresenterActive = true;
  currentRegionIndex = 0;

  // Immediately show the first region
  displayCurrentRegion();

  // Begin automated rotation
  presenterTimer = setInterval(
    advanceToNextRegion,
    REGION_DISPLAY_DURATION_MS
  );

  // Optional CSS hook for presenter-specific styling
  document.body.classList.add("presenter-mode");
}

/**
 * Stops Presenter Mode and returns control
 * to normal interactive map behavior.
 */
export function stopPresenterMode() {
  if (!isPresenterActive) return;

  console.log("[PRESENTER MODE] Stopping");

  clearInterval(presenterTimer);
  presenterTimer = null;
  isPresenterActive = false;

  document.body.classList.remove("presenter-mode");
}

/**
 * Toggles Presenter Mode on/off.
 * Useful for keyboard shortcuts or UI buttons.
 */
export function togglePresenterMode() {
  if (isPresenterActive) {
    stopPresenterMode();
  } else {
    startPresenterMode();
  }
}

/**
 * ------------------------------------------------
 * OPTIONAL: AUTO-START VIA URL PARAM
 * ------------------------------------------------
 *
 * Presenter Mode can be automatically started
 * by appending this to the URL:
 *
 *   ?mode=presenter
 *
 * Example:
 *   http://localhost:3000/?mode=presenter
 */
(function autoStartIfRequested() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "presenter") {
    startPresenterMode();
  }
})();

/**
 * ================================================================
 * END OF PRESENTER MODE CONTROLLER
 * ================================================================
 * map.js integration:
 *   - window.presenterMapController.showRegion(...)
 *   - Vehicle filtering by region bounds
 *   - Route visibility scoping
 *
 * ================================================================
 */