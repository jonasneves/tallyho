.DEFAULT_GOAL := help

.PHONY: serve eval help

serve:
	@node scripts/serve.js

eval:
	node src/eval.js

help:
	@echo ""
	@echo "\033[2mRun\033[0m"
	@echo "  \033[36mserve\033[0m      Start local server + Cloudflare tunnel for phone HTTPS"
	@echo "  \033[36meval\033[0m       Run evaluation"
	@echo ""
