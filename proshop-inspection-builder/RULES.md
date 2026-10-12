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
| Counterbore `⌴` / depth `↧` in Drawing Spec | **Moved to Spec Unit 1** (before `Ø`: `⌴ Ø`) | ProShop supports them in SU1. Number reads cleanly |
| Thread (`M2.5 - 6H`, `1/4-20 UNC`, `M6x1`) | **Note**, tolerance **blank** in all OPs | GC puts junk in Tol (`2.5 - 6`) |
| Text with no digits (`REMOVE SHARP EDGES`) | **Note** | Not measurable |
| GD&T symbols, material/finish notes | **Note** | No math on notes |

**Notes:** no math, ever. Tolerance only if typed or on the print — never a title-block default.

| Note field | OP2000 | Other OPs |
|---|---|---|
| **Drawing Spec** | Print text (or typed OP2000 fix) | Typed OUT spec if set, else OP2000 text |
| **Nom Dim** | = Drawing Spec | What GC gave, or typed OUT Nominal — else **blank** |
| **Leading zero** | Never added to note text | Never added to note text |

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

- **Leading zero always shown** on dimensions, on screen and in every OP's export: `.390` → `0.390`. Only the zero is added — decimals never change. Screen and export always match.

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

## 11. CMM import (FAI)

### Dim tag
- **First `#N`** in the CMM name is the dim tag. Later `#` numbers are part of the name.
  - `#8 Cone Angle_#8 COUNTERSINK` → 8
- **Stacked labels**: CALYPSO can print many `#N` labels on one line, then their values on the lines below.
  - Label 1 → values on that line. Label 2 → next line. And so on.
- **No `#`** → unmatched. Tag box to assign it in the import summary, and under each run in the CMM runs list.
- **Wrong tag on the CMM** → click the orange bar between Print Data and CMM Data to open the **CMM Tag** column, double-click the tag, type the right one.
  - The Print Data dim tag is never editable here — it belongs to the print.
  - Re-tagged rows show `#old → new`.
  - The measurement moves. The CMM name is never changed. The original tag is kept on the measurement.

### Units
- CMM values are stored in **print units** (converted at import, never angles).
- **Print units changed later** → CMM values are **converted**, not relabeled. They are real measured sizes, not print text.
  - Each measurement remembers its units. Old projects: assumed already in print units.

### CMM tolerance
- The CMM's **-Tol** is the signed lower deviation. Kept with its sign.
  - `-0.005` → lower limit 0.005 **below** nominal (normal).
  - `+0.005` → lower limit 0.005 **above** nominal (unilateral, e.g. `+.010 / +.005`).
- **Measured / nominal** are made positive at import (X/Y/Z included) — wanted.

### Pass / fail
- **Plan tolerance wins** when the plan row has one.
- **No plan tolerance** (or no numeric nominal) → grade with the CMM's own nominal + tolerance.
  - Why: a tol-less dim (e.g. `⌄ .248`) would otherwise be graded as zero tolerance, so everything FAILs.
- **Parent row** = worst of its measurements, graded the same way. Never disagrees with its children.
- **Count** (e.g. 6x spec, 2 measured) is not checked. Fewer measurements is not a FAIL.

## 12. FAI export (CMM results → ProShop)

Export FAI button in FAI view. **Options save with the project** (`globals.faiExport`).

### ProShop CSV columns

| Column | What goes in it |
|---|---|
| **Dim Tag #** | Same as OP2000: zero-padded number (`07`). No `REF`, no other text |
| **Measured** | The measured number only |
| **Equipment Used** | Optional. Default `CMM008`, or free text. A per-measurement equipment value wins |
| **CMM Nominal** | CMM's nominal. ProShop ignores it — kept for the record |
| **CMM Tol Upper / Lower** | CMM's tolerance, separate columns, signed limits. Normal lower is negative (`-0.0050`); unilateral keeps `+` |
| Optional | Deviation, Pass/Fail, Source Run, CMM Name — off by default |

### Runs

| Mode | Result |
|---|---|
| **All runs** / **Pick runs** | One file, or one file per run |
| **Combine (ranked)** | One file. Each dim tag comes from the **top-ranked run that has it**; lower runs fill the gaps |

- Many runs in **one file** (not combined) → **Source Run** column is forced on, so repeated tags can be told apart.

### Values

| Option | Default | Notes |
|---|---|---|
| **Units** | Print units | Or inch / mm / each run's CMM units. **Angles never converted** |
| **Decimals** | Unit default (in 4 / mm 3) | Or match print decimals (same units only), or fixed |
| **Same tag** (e.g. 6x holes) | Worst case | Worst = furthest from the middle of the tolerance zone. Or all / first / last |
| **Not measured** | Leave out | Or blank row with just the dim tag |
| **Dim tag corrections** | On | Off → the tag the CMM gave it. A CMM tag not in the plan counts as unmatched |
| **Unmatched CMM values** | Off | On → added at the end, raw CMM sign, tag blank (or the CMM's tag). Combine: one per CMM name, from the top run |

- Rows sort by dim tag number.
- Export is blocked until print units are confirmed (values convert from print units).
- File name pattern: `{part}`, `{run}`, `{date}`. Per-run / combined files add the run name.
- `{part}` = typed **Part #** → else the CMM report's part name (whole line) → else the project file name → else `Part`.
- CMM part name: CALYPSO may print the labels first (`Part name`, `Order number`…) and the values after. The first value after the label block is the part name — **only if it has a digit** (blank fields are skipped, so it could be the operator).
- Several files → each click saves the next one (browsers only open a save dialog right after a click).
- Export options are not undo steps — undo leaves them alone.

## 13. Changing a rule

1. Update this file first.
2. Update or add the test.
3. Then change the code.
