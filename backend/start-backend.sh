#!/bin/sh
set -eu

cd "$(dirname "$0")"

echo "Starting PostgreSQL..."
docker compose -f docker-compose.postgres.yml up -d

echo "Starting Milvus..."
docker compose -f docker-compose.milvus.yml up -d

echo "Running database migrations..."
npm run migrate:db

echo "Migrating legacy uploads..."
npm run migrate:uploads

echo "Generating missing embeddings..."
npm run backfill:embeddings

echo "Indexing embeddings in Milvus..."
npm run backfill:milvus

echo "Starting CountyWyde backend..."
exec npm run dev
