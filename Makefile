# Targets for the generated figures and the checks. Run `make check` before pushing.
GENS = tools/render_hero.py tools/render_map.py tools/render_panel.py
PLUGINS = salesforce partnerstack user-memory

.PHONY: figures figures-check test check

figures:
	for g in $(GENS); do python3 $$g --write || exit 1; done

figures-check:
	for g in $(GENS); do python3 $$g --check || exit 1; done

# Runs each plugin's Vitest suite and writes the JSON reports that tools/facts.py reads.
test:
	mkdir -p .reports
	for p in $(PLUGINS); do (cd plugins/$$p && npm ci --no-audit --no-fund && npx vitest run --reporter=default --reporter=json --outputFile.json=../../.reports/$$p.json) || exit 1; done

check: figures-check
	node scripts/demo-guard.mjs
	python3 tools/check_readme.py
