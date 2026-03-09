# palworld-calibration.json — Format Reference

This file stores the map calibration used to overlay player positions and exploration clouds onto the map image. It is written by the calibration UI and read at startup. Deleting it clears the calibration; the app falls back to community-estimated world bounds until recalibrated.

---

## Fields

### Affine transform coefficients

These four values are derived from the two calibration points and are the values actually used at render time. They define a linear mapping from in-game world coordinates to fractional image coordinates (0.0 = left/top edge, 1.0 = right/bottom edge).

| Field     | Type   | Description                                                          |
| --------- | ------ | -------------------------------------------------------------------- |
| `scaleX`  | number | Multiplier: `locationY` (east-west axis) → horizontal image fraction |
| `offsetX` | number | Offset: `locationY` → horizontal image fraction                      |
| `scaleY`  | number | Multiplier: `locationX` (north-south axis) → vertical image fraction |
| `offsetY` | number | Offset: `locationX` → vertical image fraction                        |

**Formula used at render time:**

```
fracX = locationY * scaleX + offsetX   // horizontal position on map image
fracY = locationX * scaleY + offsetY   // vertical position on map image
```

> Note: the UE4 X/Y axes are intentionally swapped relative to the map image axes. `locationX` (north-south in-game) maps to the vertical axis of the image; `locationY` (east-west) maps to the horizontal axis.

---

### Calibration source points

The two reference points the user clicked during calibration. These are stored for informational purposes and are not used at render time — only the derived coefficients above are used.

| Field      | Type   | Description                                      |
| ---------- | ------ | ------------------------------------------------ |
| `p1WorldX` | number | Point 1 — in-game X coordinate (north-south)     |
| `p1WorldY` | number | Point 1 — in-game Y coordinate (east-west)       |
| `p1FracX`  | number | Point 1 — horizontal fraction of map image (0–1) |
| `p1FracY`  | number | Point 1 — vertical fraction of map image (0–1)   |
| `p2WorldX` | number | Point 2 — in-game X coordinate (north-south)     |
| `p2WorldY` | number | Point 2 — in-game Y coordinate (east-west)       |
| `p2FracX`  | number | Point 2 — horizontal fraction of map image (0–1) |
| `p2FracY`  | number | Point 2 — vertical fraction of map image (0–1)   |

---

## Example

```json
{
  "scaleX":  6.889565757960398e-7,
  "offsetX": 0.5106410941207984,
  "scaleY": -6.91117470319859e-7,
  "offsetY": 0.3095469204507833,
  "p1WorldX":  399893,
  "p1WorldY":  117546,
  "p1FracX": 0.7861500060856041,
  "p1FracY": 0.2283088262845651,
  "p2WorldX": -62320,
  "p2WorldY": -465384,
  "p2FracX": 0.4677053203171892,
  "p2FracY": 0.6311819332581206
}
```

---

## Location

Controlled by the `CALIBRATION_PATH` environment variable. Default: `/app/data/palworld-calibration.json`

This file is intentionally separate from the location history database (`palworld-location.db`) so that either can be deleted independently:

- Delete `palworld-calibration.json` → clears calibration only; location history is preserved but clouds will not align until recalibrated.
- Delete `palworld-location.db` → clears location history only; calibration is preserved and recalibration is not needed.
