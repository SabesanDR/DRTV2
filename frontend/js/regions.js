/**
 * ================================================================
 * DRT Operations Hub — Presenter Mode Region Definitions
 * ================================================================
 *
 * PURPOSE
 * -------
 * This file defines ALL municipal regions serviced by
 * Durham Region Transit (DRT).
 *
 * It is used by Presenter Mode to:
 *   - Automatically rotate the map between regions
 *   - Zoom the map to each municipality
 *   - Filter live vehicles by GPS position
 *   - Display only buses operating within that region
 *
 * This file contains **no logic**.
 * It is intentionally declarative and data-only.
 *
 * ------------------------------------------------
 * DESIGN PRINCIPLES
 * ------------------------------------------------
 * 1. Regions are defined by BOUNDING BOXES, not routes
 *    - Faster than polygons
 *    - Easy to tweak
 *    - Works natively with Leaflet
 *
 * 2. Vehicle inclusion is GPS-based
 *    - If a bus is physically in the region, it belongs
 *
 * 3. Bounds are intentionally slightly generous
 *    - Prevents edge clipping
 *    - Avoids flickering as buses cross borders
 *
 * ------------------------------------------------
 * COORDINATE FORMAT
 * ------------------------------------------------
 * Bounds are defined as:
 *   [[SOUTH_LAT, WEST_LON], [NORTH_LAT, EAST_LON]]
 *
 * This format matches Leaflet's `fitBounds()` API exactly.
 *
 * Latitude  = North / South
 * Longitude = East / West
 *
 * ------------------------------------------------
 * ORDERING
 * ------------------------------------------------
 * Regions are ordered WEST → EAST, URBAN → RURAL.
 * This creates a natural, logical flow during presentations:
 *
 *   Pickering → Ajax → Whitby → Oshawa → Clarington
 *   → Uxbridge → Scugog → Brock
 *
 * Each region is expected to be displayed for ≥ 1 minute.
 *
 * ================================================================
 */

export const REGIONS = [

  /**
   * --------------------------------------------------------------
   * PICKERING
   * --------------------------------------------------------------
   * Western gateway to Durham Region.
   * Dense urban service with frequent routes and terminals.
   */
  {
    id: "pickering",                 // machine-readable identifier
    name: "Pickering",               // human-friendly display name

    // Geographic bounding box (Leaflet-compatible)
    bounds: [
      [43.800, -79.200],             // southwest corner
      [43.890, -79.060]              // northeast corner
    ]
  },

  /**
   * --------------------------------------------------------------
   * AJAX
   * --------------------------------------------------------------
   * High-intensity north–south service.
   * Includes GO connections and peak-period demand.
   */
  {
    id: "ajax",
    name: "Ajax",
    bounds: [
      [43.810, -79.070],
      [43.900, -78.990]
    ]
  },

  /**
   * --------------------------------------------------------------
   * WHITBY
   * --------------------------------------------------------------
   * Transitional municipality between Ajax and Oshawa.
   * Mix of local routes and express service.
   */
  {
    id: "whitby",
    name: "Whitby",
    bounds: [
      [43.840, -78.980],
      [43.925, -78.880]
    ]
  },

  /**
   * --------------------------------------------------------------
   * OSHAWA
   * --------------------------------------------------------------
   * Eastern urban core of DRT.
   * Highest vehicle density and route frequency.
   */
  {
    id: "oshawa",
    name: "Oshawa",
    bounds: [
      [43.870, -78.930],
      [43.970, -78.820]
    ]
  },

  /**
   * --------------------------------------------------------------
   * CLARINGTON
   * --------------------------------------------------------------
   * Largest municipality by area.
   * Long-haul, express, and commuter-focused services.
   *
   * Given its size, presenters may optionally
   * keep this region on screen slightly longer.
   */
  {
    id: "clarington",
    name: "Clarington",
    bounds: [
      [43.900, -78.850],
      [44.250, -78.350]
    ]
  },

  /**
   * --------------------------------------------------------------
   * UXBRIDGE
   * --------------------------------------------------------------
   * Northern Durham municipality.
   * Lower service frequency, wide geographic coverage.
   */
  {
    id: "uxbridge",
    name: "Uxbridge",
    bounds: [
      [43.980, -79.350],
      [44.120, -79.100]
    ]
  },

  /**
   * --------------------------------------------------------------
   * SCUGOG
   * --------------------------------------------------------------
   * Includes Port Perry and surrounding rural communities.
   * Service emphasizes coverage over frequency.
   */
  {
    id: "scugog",
    name: "Scugog",
    bounds: [
      [44.050, -79.350],
      [44.200, -79.050]
    ]
  },

  /**
   * --------------------------------------------------------------
   * BROCK
   * --------------------------------------------------------------
   * Northernmost and most rural service area.
   * Lowest vehicle density but critical coverage region.
   *
   * This region is important to showcase
   * system equity and geographic reach.
   */
  {
    id: "brock",
    name: "Brock",
    bounds: [
      [44.200, -79.350],
      [44.350, -79.050]
    ]
  }

];

/**
 * ================================================================
 * END OF REGION DEFINITIONS
 * ================================================================
 *
 * NEXT STEPS
 * ----------
 * This file will be imported by:
 *   - presenter.js   → region rotation logic
 *   - map.js         → zoom + vehicle filtering
 *
 * No changes should be made here unless:
 *   - municipal boundaries change
 *   - presenter feedback requires tighter bounds
 *
 * ================================================================
 */
