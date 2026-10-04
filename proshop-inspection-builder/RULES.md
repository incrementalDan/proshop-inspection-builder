# RULES — What the app does, and why

**This file is the source of truth for output rules.**
If code and this file disagree, the code is wrong — or this file needs updating first.
Every rule here has a test in `test/` (run `node test/run-node.js`).

---

## 1. Purpose

- **Input** → inspection data for a part (every dimension, tolerance, note on the print).
- **Output** → a CSV that imports straight into ProShop.
- **Origin** → built to fix bad Ground Control (GC) CSVs and output better ProShop data.

### Two ways in, one way out

| Input path | What it is |
|---|---|
| **GC CSV import** | The original path. GC's AS9102C CSV, cleaned up by the parser. |
| **Ballooning** | Draw boxes on the PDF. Same data GC gives, plus balloon positions. |

- Both paths create the **same row shape** (`{ raw, user, computed }`).
- Everything after row creation (math, overrides, export) is **shared**.
- Ballooning is **not** a separate workflow. It is just another way to fill the table.
- The GC path must keep working. Never remove it.

---

## 2. Ops: OP2000 vs other OPs

| | OP2000 | Other OPs (50, 60…) |
|---|---|---|
| **What it is** | The print, as written | What the machinist measures |
| **Units** | Print units — never converted | Export units |
| **Math** | None | Centering, plating, pin/gage |
| **Dim Tag** | Zero-padded number: `01`, `12` | Frequency letter + `REF-` + padded: `HREF-07` |
| **Nom Dim** | Always = Drawing Spec | Drawing Spec + plating label, or pin/gage, or typed OUT Nominal |
| **Not-on-print (REF only) rows** | Never exported | Exported normally |

**Why OP2000 gets no math:** it's the record of the print. If it's wrong, the fix is a typed OP2000 override — never a calculation.

**Data flows one way:** OP2000 → other OPs. Editing an OUT value never changes OP2000.

---

## 3. Pipeline (order matters)

```
Raw input → 1 Parse → 2 Overrides → [OP2000 values]
                                         ↓
                                   4 Centering
                                         ↓
                                   3 Plating / pin-gage
                                         ↓
                                   [Other OP values]
                                         ↓
                        Typed OUT override? → use it (plating still applies)
```

1. **Parse** — put GC's messy text into the right columns. Never changes the meaning.
2. **Overrides** — user fixes a misread. OP2000 overrides feed the math downstream.
3. **Modifiers** — plating, pin/gage, frequency tag. Other OPs only.
4. **Centering** — asymmetric tol → symmetric. `.100 +.005/-.002` → `.1015 ±.0035`. Other OPs only.

---

## 4. Parsing rules (Type 1)

| Input | Result | Why |
|---|---|---|
| `⌀` / `∅` | `Ø` in Spec Unit 1 (export writes `⌀`) | One symbol internally |
| `2 HOLES`, `4 PLACES` | `2x`, `4x` in Spec Unit 3 | ProShop format |
| `THRU`, `DEEP`, `TYP`, `°`… | Spec Unit 2 | ProShop format |
| Countersink `⌄` / `⌵` in Drawing Spec | **Removed** | Blocks the number. ProShop handling unknown — revisit later |
| Thread (`M2.5 - 6H`, `1/4-20 UNC`, `M6x1`) | **Note**, tolerance **blank** in all OPs | GC puts junk in Tol (`2.5 - 6`) |
| Text with no digits (`REMOVE SHARP EDGES`) | **Note** | Not measurable |
| GD&T symbols, material/finish notes | **Note** | No math on notes |

**Notes:** no math, ever. Tolerance only if typed or on the print — never a title-block default.

---

## 5. Precision (decimal places)

| Situation | Decimals |
|---|---|
| **Same units** in and out, no math | **As printed**: `.390 ±0.005` → `.390 ±.005` |
| **Same units**, math changed the value (plating, centering) | **Print decimals or unit default, whichever is more**: `.081` +2xI .0002 → `.0814` |
| **Converted** (inch ↔ mm) | **Unit default**: inch 4, mm 3 |
| **Angles** | Always as printed (never converted): `90 ±0.5` → `90 ±.5` |
| **OP2000** | As printed / as typed. Never reformatted. |
| **Typed OUT values** | As typed (same units) |
| **No tolerance anywhere** | Tol column **blank**, not `.0000` |

**Why:** inch prints carry meaning in their decimals (`.25` ≠ `.250` for tolerancing). Math on a value must not be rounded away.

- Leading zero is dropped on other OPs (`0.005` → `.005`). ProShop convention.

---

## 6. Plating

- Drawing Spec is the **after-plating** size. We output the **machining** size.
- `+1xI` / `+2xI` (internal, hole shrinks) → **add** 1× / 2× plating.
- `-1xE` / `-2xE` (external, part grows) → **subtract** 1× / 2× plating.
- **Never** applied to tolerance.
- A typed OUT spec is plated too.
- Nom Dim shows the label: `.0814 (+2xI)`.

---

## 7. Pin / Gage

- **GO / NO-GO** → `P(Ø{nom−tol}+ | Ø{nom+tol}-)`
- **Gage Block**, or any asymmetric tol → `G({nom−tolMinus} | {nom+tolPlus})`
- Pin/Gage on → Nom Dim = the pin/gage value. Typed OUT Nominal is locked out.
- Computed in export units. A hand-typed pin value exports exactly as typed.

---

## 8. Nom Dim is a free field

- ProShop's "Nom Dim" is **not** a nominal. ProShop does no math on it.
- Never use it as a math input. The real number is Drawing Spec + Tol.
- A typed OUT Nominal exports exactly as typed: no conversion, no plating.

---

## 9. Dim Tag naming (other OPs)

`<letter>REF-<2-digit tag>` — letter from inspection frequency:

| 1 in 1 | 1 in 2 | 1 in 3 | 1 in 4 | 1 in 5 | 1 in 10 | 1 in 20 | 1 in 50 | First and Last | blank |
|---|---|---|---|---|---|---|---|---|---|
| A | B | C | D | E | F | G | H | I | none |

- **Why:** ProShop sorts by tag, so the most-checked dims sort to the top.
- A hand-typed tag is kept. Auto tags (`REF-07`, `AREF-07`…) update when frequency changes.

---

## 10. Print units

**Model:** every value stays in the units it was written in. Like a label on a parts bin — the parts don't change when you relabel the bin.

- **Print units** (`globals.importUnits`, mm/in toggle) = the units the print is drawn in.
- **All math runs in print units.** Conversion happens only at the edges: the `[bracket]` value on screen, and the export.
- **Typed values** are in print units.
- **Not "everything in mm"** — that would lose print decimals and add rounding noise.

### Detect → confirm → export

| Step | What happens |
|---|---|
| **Import** | App guesses units from the values and sets them. Status: **not confirmed**. |
| **Banner** | "Looks like INCH — Confirm / Use MM", with the reasons. |
| **Export** | **Blocked** until confirmed. You can confirm right in the export dialog. |
| **Old projects** | Open with their saved units, **not confirmed**. |

Detection clues (title block text from the PDF beats everything):

| Clue | Points to |
|---|---|
| "DIMENSIONS ARE IN INCHES / MM" on the PDF | That unit (decisive) |
| Leading dot `.390` | Inch |
| 3–4 decimals | Inch |
| 1–2 decimals | mm |
| Value > 50 | mm |
| Tolerance < .02 | Inch |
| Tolerance ≥ .05 | mm |

- Notes, angles and metric threads are ignored (inch prints use M-threads too).
- **High confidence** = enough clues, 80%+ agree.

### Changing print units later

- **Relabel, never convert** the print values. Nothing is lost: overrides, balloons, plating, frequencies, tags all stay.
- **Values you typed** get a review list: **Keep as typed** (default) or **Convert them**.
- Undo works.

### Mismatch warning

- After confirming, the detector keeps checking.
- Confident the values look like the *other* unit → red banner: "Switch / Keep".
- "Keep" silences it until units change.

### Other unit settings

| Setting | Why it's separate |
|---|---|
| **Export units** | What ProShop/the machinist wants. Chosen at export. |
| **Plating units** | Plating spec is often in a different unit than the print. |
| **Title block units** | Title block tolerances entered in their own unit. Converted **live** when used — never stored, so never stale. |
| **CMM units** | Units of the CMM report. |

- Balloon rows set to **Default / Profile** tolerance follow the title block live.

## 11. Changing a rule

1. Update this file first.
2. Update or add the test.
3. Then change the code.
