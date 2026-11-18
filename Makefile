PORT ?= 8000

.PHONY: site open-site

# Serve the website (site/) at http://localhost:$(PORT), as gpushed.dev serves it.
site:
	@echo "Serving site/ at http://localhost:$(PORT) (Ctrl+C to stop)"
	python3 -m http.server $(PORT) -d site

# Open the page straight from disk, no server.
open-site:
	open site/index.html
