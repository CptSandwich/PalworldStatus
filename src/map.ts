// Palworld world coordinate → map image pixel transform
//
// These constants map UE4 world coordinates to pixel positions on palworld-map.jpg.
// The values below are approximate and should be calibrated against in-game
// known landmark positions once the actual map image dimensions are confirmed.
//
// Calibration method:
//   1. Note the in-game world coordinates at two distant landmarks (e.g. spawn point, far corner)
//   2. Find the corresponding pixel positions in the map image
//   3. Solve for the linear transform: px = (worldX - WORLD_MIN_X) / (WORLD_MAX_X - WORLD_MIN_X) * MAP_WIDTH
//
// Palworld REST API coordinate system:
//   1 API unit ≈ 10 real-world metres (UE4 cm / 1000)
//   Origin (0, 0) is roughly the map centre.
//   Known bounds as of current map version (map continues to expand):
//     SW corner ≈ (-582, -301), NE corner ≈ (335, 617)
//   We pad slightly beyond known bounds so dots never clip at the edges.
//   Use the in-app calibration tool to fine-tune the mapping for your map image.
const WORLD_MIN_X = -650;
const WORLD_MAX_X = 450;
const WORLD_MIN_Y = -350;
const WORLD_MAX_Y = 700;

// Update these when you have the actual map image dimensions
export const MAP_WIDTH_PX = 2048;
export const MAP_HEIGHT_PX = 2048;

export interface PixelPos {
  x: number;
  y: number;
}

export function worldToPixel(worldX: number, worldY: number): PixelPos {
  const x = ((worldX - WORLD_MIN_X) / (WORLD_MAX_X - WORLD_MIN_X)) * MAP_WIDTH_PX;
  // Y axis may be inverted depending on map image orientation
  const y = ((worldY - WORLD_MIN_Y) / (WORLD_MAX_Y - WORLD_MIN_Y)) * MAP_HEIGHT_PX;
  return {
    x: Math.round(Math.max(0, Math.min(MAP_WIDTH_PX, x))),
    y: Math.round(Math.max(0, Math.min(MAP_HEIGHT_PX, y))),
  };
}

// Export calibration constants for use in frontend app.js
export const MAP_CALIBRATION = {
  worldMinX: WORLD_MIN_X,
  worldMaxX: WORLD_MAX_X,
  worldMinY: WORLD_MIN_Y,
  worldMaxY: WORLD_MAX_Y,
  mapWidthPx: MAP_WIDTH_PX,
  mapHeightPx: MAP_HEIGHT_PX,
};
