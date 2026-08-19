# LanderForge — common tasks.
#
# `make` on its own lists the targets.

.DEFAULT_GOAL := help
.PHONY: help install dev db-start db-reset db-stop seed test test-db verify build docker clean

help: ## List available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies from the lockfile
	pnpm install --frozen-lockfile

dev: ## Run the app and the Inngest dev server together
	pnpm run dev & pnpm run inngest; wait

db-start: ## Start the local Supabase stack (postgres, auth, realtime, studio)
	supabase start

db-reset: ## Recreate the database and apply every migration
	supabase db reset

db-stop: ## Stop the local Supabase stack
	supabase stop

seed: ## Upsert manifests/ into the templates table
	pnpm run seed

test: ## Run the unit tests
	pnpm run test

test-db: ## Run the pgTAP RLS and invariant tests
	supabase test db

verify: ## Typecheck, lint and unit tests — what CI runs
	pnpm run verify

build: ## Production build
	pnpm run build

docker: ## Build the production image
	docker build -t landerforge:local .

clean: ## Remove build output and caches
	rm -rf .next node_modules/.cache coverage

seed-dev: ## Create a local admin account (local Supabase only)
	pnpm run seed:dev
