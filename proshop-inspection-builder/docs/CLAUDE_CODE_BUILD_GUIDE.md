# Claude Code Build Guide — Step-by-Step Prompts

This file contains the exact prompts to give Claude Code, in order.
Run each one, verify it works, then `git commit` before moving on.

## Setup (do this first)

```bash
cd proshop-inspection-builder
git init
git add .
git commit -m "initial scaffold from template"
claude
```

Once inside Claude Code, run `/init` to let it learn the project.

---

## Phase 1: Verify the Scaffold Works

**Prompt:**
> Open test/index.html mentally and check that parser.test.js and mathEngine.test.js 
> import correctly from the js/ modules. Fix any import path issues. Then open 
> index.html and verify the app loads without console errors. Fix anything broken.

**Verify:** Open `index.html` in browser — should see dark UI with "No Data Loaded". Open `test/index.html` — tests should run.

```bash
git add . && git commit -m "fix: verify scaffold loads correctly"
```

---

## Phase 2: CSV Import End-to-End

**Prompt:**
> Import data/sample-input.csv through the Import CSV button. The 16 rows should 
> appear in the table. Dim tags 1-16, rows 14-16 should be detected as notes 
> (italic styling). Spec Unit 1 column should show Ø for rows 7, 8, 9. Spec Unit 3 
> should show 2x for row 9 and 4x for row 11. Fix the import pipeline until this works.

**Verify:** Click Import CSV → select `data/sample-input.csv` → 16 rows appear, notes are italic, Ø and quantity values display correctly.

```bash
git add . && git commit -m "feat: CSV import working with note detection"
```

---

## Phase 3: Sidebar Controls

**Prompt:**
> Click any dimension row (not a note). The sidebar should open on the right 
> showing the dim tag big at the top, the output drawing spec and tolerance 
> prominently displayed, and all controls below. Changing any control (IPC checkbox, 
> equipment dropdown, plating mode, frequency) should update the row's user state 
> and trigger a recompute. The output preview in the sidebar should update in real 
> time. Make sure the sidebar resizer works (drag the left edge to resize).

**Verify:** Click row → sidebar opens. Toggle controls → values update in real time. Resize sidebar by dragging.

```bash
git add . && git commit -m "feat: sidebar controls with real-time recompute"
```

---

## Phase 4: OP Management

**Prompt:**
> Add OPs using the OP bar at the top. Type "2000" and press Enter/click +. 
> Then add "50". OP2000 should show with an orange border. In the sidebar, OP toggle 
> buttons should appear for each OP. Toggling an OP on for a row should show that OP 
> number in the OPs column of the table. Make sure removing an OP from the bar also 
> removes it from all row data.

**Verify:** Add OP 2000 and OP 50 → tags appear. Toggle OPs per row → OPs column updates.

```bash
git add . && git commit -m "feat: OP management with per-row toggles"
```

---

## Phase 5: Math Engine Integration

**Prompt:**
> With sample data imported and import units set to "mm":
> 1. Set plating thickness to 0.001 and plating units to "inch"
> 2. Select row 1 (33.0 mm, ±0.5). Set plating mode to "-2x External". 
>    The OUT Nominal should show the plating-adjusted value with "(-2xE)" annotation.
> 3. Tolerance should NOT change when plating is applied — only nominal changes.
> 4. Test nominal centering: create a test with asymmetric tolerance manually. 
>    Verify the math matches: nominal = original + (tolPlus - tolMinus)/2
> 5. Verify OP2000 rows export with ZERO math applied — raw values only.
> Run the test suite and make sure all math tests pass.

**Verify:** Check math values against manual calculations. Run tests.

```bash
git add . && git commit -m "feat: math engine integration (plating, centering, OP2000)"
```

---

## Phase 6: Export

**Prompt:**
> Click Export CSV. A modal should show checkboxes for each OP and a units selector. 
> Select OP 50, click Download CSV. The exported file should have:
> - Correct ProShop headers (exact match to data/sample-output.csv headers)
> - Op # column populated with "50"
> - Dim Tag # with the configured prefix (set prefix "HREF-" for OP 50 in Settings)
> - Nom Dim includes plating annotation like "1.2982 (-2xE)"
> - IPC? shows "TRUE" for rows with IPC checked
> - Only rows with OP 50 toggled on are included
> Compare the structure against data/sample-output.csv.

**Verify:** Export CSV and open in text editor. Compare structure against sample-output.csv.

```bash
git add . && git commit -m "feat: ProShop CSV export with OP filtering"
```

---

## Phase 7: Save/Load & Polish

**Prompt:**
> 1. Save Project should download a .json file with all rows, user overrides, 
>    and global settings. Load Project should restore the full session.
> 2. Auto-save to localStorage should happen after every change (debounced 1s). 
>    Refreshing the page should restore the previous session.
> 3. Add inline editing: double-click OUT Drawing Spec, OUT Tolerance, or Pin/Gage 
>    cells to edit them directly in the table. These should set user overrides.
> 4. Light/dark theme toggle should work (click the ◑ button).
> 5. Settings modal: equipment list should be editable (one per line), 
>    and OP prefixes should be configurable per OP.

**Verify:** Save → close browser → Load → all data restored. Inline edit cells. Toggle theme.

```bash
git add . && git commit -m "feat: save/load, inline editing, theme toggle"
git tag v1.0-mvp
```

---

## Phase 8: Unit Conversion (if needed)

**Prompt:**
> Add unit conversion to the math pipeline. When export units differ from import units:
> - mm→inch: divide by 25.4
> - inch→mm: multiply by 25.4
> Apply to nominal and tolerance values.
> OP2000 MUST still bypass this — raw values only regardless of unit settings.
> Add tests for round-trip conversion accuracy.

---

## Troubleshooting Tips

If something breaks:
1. `git diff` to see what changed
2. `git stash` to temporarily undo, test, then `git stash pop` to bring changes back
3. Tell Claude Code: "The last change broke X. Revert the changes to [file] and try a different approach."
4. Keep changes small — it's easier to isolate bugs in a 20-line change than a 200-line change.
