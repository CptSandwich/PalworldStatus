# palworld-calibration.json — Format Reference

This file stores the map calibration used to overlay player positions and exploration clouds onto the map image. It is written by the calibration UI and read at startup. Deleting it clears the calibration; the app falls back to community-estimated world bounds until recalibrated.

---

## Coordinate Systems

There are three distinct coordinate systems in play. Understanding how they relate is essential for calibration.

### 1. Palworld REST API coordinates (`location_x`, `location_y`)

The raw coordinates returned by the Palworld dedicated server REST API for each player. These are Unreal Engine 4 world-space coordinates in centimetres.

| API field    | In-game direction | Maps to                                    |
| ------------ | ----------------- | ------------------------------------------ |
| `location_x` | North–south       | Vertical axis of the map image (`fracY`)   |
| `location_y` | East–west         | Horizontal axis of the map image (`fracX`) |

**The X and Y axes are swapped relative to the map image.** The UE4 X axis runs north–south (top–bottom on the image), and the UE4 Y axis runs east–west (left–right on the image). This is an intentional quirk of the game's world orientation.

Typical range: approximately −1,000,000 to +450,000 on each axis.

---

### 2. Palworld HUD coordinates (display coordinates)

The two numbers shown in the Palworld in-game HUD (F1 menu / coordinate display). These are a scaled, offset version of the API coordinates and are what the calibration UI asks the user to enter.

**API → HUD conversion:**

```
HUD_X = round((location_y - 158000) / 459)   // east-west → horizontal
HUD_Y = round((location_x + 123888) / 459)   // north-south → vertical
```

**HUD → API inverse (used internally when calibration points are confirmed):**

```
location_y = HUD_X * 459 + 158000   // east-west API coord, drives fracX
location_x = HUD_Y * 459 - 123888   // north-south API coord, drives fracY
```

**Origin of the constants:**

The three constants were determined empirically by the [`palworld-coord`](https://github.com/palworld-coord/palworld-coord) community project. Contributors stood at identifiable landmarks (coastline features, roads, structures), recorded the HUD display value shown in the F1 menu, and simultaneously read the raw API `location_x`/`location_y` from the REST endpoint. A linear fit across many such readings yielded:

- **scale = 459** — the number of UE4 world-space centimetres per HUD unit. Put differently, moving 1 unit on the HUD corresponds to 4.59 metres of real in-game distance. The value does not appear to derive from a round game design number; it was fitted from data.
- **offset_y = 158,000** — the `location_y` API value that corresponds to HUD_X = 0 (the east–west zero line of the HUD grid).
- **offset_x = 123,888** — subtracted from `location_x` before dividing, shifting the north–south zero point to match where HUD_Y = 0 appears on the map.

These constants are stable across server versions as they reflect the fixed world geometry of the Palpagos Islands, not any server-side setting. They have been cross-checked against live server data and match to within ±1 HUD unit at all tested positions.

---

### 3. Map image fractional coordinates (`fracX`, `fracY`)

Position on the map image expressed as a fraction of the image dimensions.

| Value         | Meaning              |
| ------------- | -------------------- |
| `fracX = 0.0` | Left edge of image   |
| `fracX = 1.0` | Right edge of image  |
| `fracY = 0.0` | Top edge of image    |
| `fracY = 1.0` | Bottom edge of image |

These are produced by clicking a point on the map image in the calibration UI.

---

## How Calibration Is Calculated

The user provides two reference points. For each point they:

1. Click a known landmark on the map image → gives `fracX`, `fracY`
2. Stand at that landmark in-game and read the HUD coordinates → converted to API coords

The HUD coordinates are converted to API coordinates via the inverse formula above, then stored in the JSON as `p1WorldX` / `p1WorldY` etc.

> **Naming note:** In the JSON, `p1WorldX` is the value that drives the horizontal (X) axis of the image — which is `location_y` (the east-west API field), not `location_x`. Similarly, `p1WorldY` drives the vertical (Y) image axis — which is `location_x` (north-south). The names refer to image axes, not UE4 axes.

From the two points, the affine scale and offset are derived using a two-point linear fit:

```
scaleX  = (p2.fracX - p1.fracX) / (p2.worldX - p1.worldX)
offsetX = p1.fracX - p1.worldX * scaleX

scaleY  = (p2.fracY - p1.fracY) / (p2.worldY - p1.worldY)
offsetY = p1.fracY - p1.worldY * scaleY
```

Where `worldX` = the east-west API value (`location_y`) and `worldY` = the north-south API value (`location_x`).

---

## Fields

### Affine transform coefficients

These four values are derived from the calibration points and are the only values used at render time.

| Field     | Type   | Description                                                                     |
| --------- | ------ | ------------------------------------------------------------------------------- |
| `scaleX`  | number | Multiplier applied to `location_y` (east-west) to get horizontal image fraction |
| `offsetX` | number | Additive offset for the horizontal mapping                                      |
| `scaleY`  | number | Multiplier applied to `location_x` (north-south) to get vertical image fraction |
| `offsetY` | number | Additive offset for the vertical mapping                                        |

**Render-time formula:**

```
fracX = location_y * scaleX + offsetX   // horizontal position on map image (0–1)
fracY = location_x * scaleY + offsetY   // vertical position on map image (0–1)

pixel_x = fracX * image_width_px
pixel_y = fracY * image_height_px
```

This formula is applied identically for:

- Live player dot positions
- Exploration fog cloud polygon vertices (via grid cell → world coord → fracX/fracY)

---

### Calibration source points

The two reference points entered during calibration. Stored for reference only — not used at render time.

| Field      | Type   | Description                                                           |
| ---------- | ------ | --------------------------------------------------------------------- |
| `p1WorldX` | number | Point 1 — `location_y` API value (east-west, drives fracX)            |
| `p1WorldY` | number | Point 1 — `location_x` API value (north-south, drives fracY)          |
| `p1FracX`  | number | Point 1 — horizontal image fraction where the point was clicked (0–1) |
| `p1FracY`  | number | Point 1 — vertical image fraction where the point was clicked (0–1)   |
| `p2WorldX` | number | Point 2 — `location_y` API value                                      |
| `p2WorldY` | number | Point 2 — `location_x` API value                                      |
| `p2FracX`  | number | Point 2 — horizontal image fraction                                   |
| `p2FracY`  | number | Point 2 — vertical image fraction                                     |

To recover the HUD coordinates that were entered for a stored calibration point:

```
HUD_X = round((p1WorldX - 158000) / 459)
HUD_Y = round((p1WorldY + 123888) / 459)
```

---

## Exploration Grid Relationship

The exploration fog (location history) is stored as a 2048×2048 bitmap grid keyed by steam ID. Grid coordinates are computed from raw API coordinates:

```
GRID_CELL_SIZE = 1,447,840 / 2048 ≈ 706.96 API units per cell
WORLD_MIN_X    = −999,940   // location_x minimum (north-south)
WORLD_MIN_Y    = −738,920   // location_y minimum (east-west)

col = floor((location_y - WORLD_MIN_Y) / GRID_CELL_SIZE)   // horizontal
row = floor((location_x - WORLD_MIN_X) / GRID_CELL_SIZE)   // vertical
```

When rendering, grid cells are converted back to world API coordinates, then to image fractions using the calibration above. This means the exploration fog and live player dots use the same transform and will always align with each other as long as the calibration is accurate.

---

## Example

```json
{
  "scaleX":   6.889565757960398e-7,
  "offsetX":  0.5106410941207984,
  "scaleY":  -6.91117470319859e-7,
  "offsetY":  0.3095469204507833,
  "p1WorldX":  399893,
  "p1WorldY":  117546,
  "p1FracX":  0.7861500060856041,
  "p1FracY":  0.2283088262845651,
  "p2WorldX": -62320,
  "p2WorldY": -465384,
  "p2FracX":  0.4677053203171892,
  "p2FracY":  0.6311819332581206
}
```

To verify: `p1WorldX = 399893` → HUD_X = round((399893 − 158000) / 459) = round(526.9) ≈ 527. `p1WorldY = 117546` → HUD_Y = round((117546 + 123888) / 459) = round(525.9) ≈ 526. So this point was calibrated at HUD coordinates (527, 526).

---

## Location

Controlled by the `CALIBRATION_PATH` environment variable. Default: `/app/data/palworld-calibration.json`

This file is intentionally separate from the location history database (`palworld-location.db`) so that either can be deleted independently:

- Delete `palworld-calibration.json` → clears calibration only; location history is preserved but exploration clouds will not render correctly until recalibrated.
- Delete `palworld-location.db` → clears location history only; calibration is preserved and recalibration is not needed.
