.PHONY: help dev up down build logs migrate seed test clean monitoring monitoring-down

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

dev: ## Start local development (docker-compose)
	docker compose up --build

up: ## Start services in background
	docker compose up -d --build

down: ## Stop all services
	docker compose down

build: ## Build Docker image only
	docker build -t church-cms:latest .

logs: ## View application logs
	docker compose logs -f app

migrate: ## Run database migrations
	docker compose exec app node db/migrate.js

seed: ## Seed database with admin user
	docker compose exec app node db/seed.js

test: ## Run tests
	npm test

clean: ## Remove all containers, volumes, and images
	docker compose down -v --rmi local
	rm -f church.db

status: ## Check service health
	@echo "App health:"
	@curl -s http://localhost:3000/health | python3 -m json.tool 2>/dev/null || echo "App not running"
	@echo "\nApp readiness:"
	@curl -s http://localhost:3000/ready | python3 -m json.tool 2>/dev/null || echo "App not ready"

monitoring: ## Start app + full monitoring stack (Prometheus, Grafana, Loki, Jaeger)
	docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up --build

monitoring-down: ## Stop monitoring stack
	docker compose -f docker-compose.yml -f docker-compose.monitoring.yml down
