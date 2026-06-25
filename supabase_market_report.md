# Supabase Market Report

> **Product:** Supabase  
> **Category:** Backend-as-a-Service (BaaS)  
> **Research Date:** 2026-05-27  
> **Description:** Open-source backend-as-a-service platform providing PostgreSQL database, authentication, file storage, instant APIs, edge functions, and realtime capabilities. Positioned as an open-source alternative to Firebase with SQL instead of NoSQL.

---

## Table of Contents

1. [Pricing Plan Comparison](#1-pricing-plan-comparison)
2. [Resource Limits by Plan](#2-resource-limits-by-plan)
3. [Features by Plan](#3-features-by-plan)
4. [Overage Pricing](#4-overage-pricing)
5. [Add-Ons](#5-add-ons)
6. [Key Platform Features](#6-key-platform-features)
7. [Notable Details & Insights](#7-notable-details--insights)
8. [Sources](#8-sources)

---

## 1. Pricing Plan Comparison

| Feature | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| **Cost** | $0/month | $25/month per project (includes $10 compute credits) | $25/month per project (usage-based scaling) | Custom pricing |
| **Target Audience** | Learning, prototyping, MVPs | Production apps needing predictable performance | Startups & small teams needing SSO/audit logs | Large-scale apps with compliance needs |
| **Project Pausing** | Yes — after 1 week of inactivity | No | No | No |
| **Spend Cap** | N/A | Enabled by default | Enabled by default | Custom |
| **Support** | Community | Email | Stronger than Pro | Custom SLAs |
| **Backups** | None | Daily, 7-day retention | Daily, 7-day retention | PITR up to 28-day retention |
| **Log Retention** | None | 7 days | 7 days | Custom |
| **SSO** | ❌ | ❌ | ✅ | ✅ |
| **Audit Logs** | ❌ | ❌ | ✅ | ✅ |
| **SOC 2 Type II** | ❌ | ❌ | ❌ | ✅ |
| **HIPAA (with BAA)** | ❌ | ❌ | ❌ | ✅ |
| **Private VPC** | ❌ | ❌ | ❌ | ✅ |
| **Regional Replication** | ❌ | ❌ | ❌ | ✅ |
| **Custom Domains** | ❌ | ❌ | ❌ | ✅ |
| **Custom Quotas** | ❌ | ❌ | ❌ | ✅ |
| **Dedicated Infrastructure** | ❌ | ❌ | ❌ | ✅ |

---

## 2. Resource Limits by Plan

| Resource | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| **Active Projects** | 2 | Unlimited | Unlimited | Custom |
| **Organization Members** | 1 | Unlimited | Unlimited | Custom |
| **Database Size** | 500 MB (shared CPU) | 8 GB per project | 8 GB per project | Custom |
| **Database Egress** | 5 GB/month | 250 GB (then $0.09/GB) | 250 GB (then $0.09/GB) | Custom |
| **Cached Egress** | 5 GB/month | 250 GB (then $0.03/GB) | 250 GB (then $0.03/GB) | Custom |
| **Auth MAUs** | 50,000 | 100,000 (then $0.00325/MAU) | Higher than Pro | Custom |
| **File Storage** | 1 GB | 100 GB (then $0.021/GB/month) | 100 GB (then $0.021/GB/month) | Custom |
| **Storage Egress** | 5 GB/month | 250 GB (then $0.09/GB) | 250 GB (then $0.09/GB) | Custom |
| **Edge Function Invocations** | 500,000 | 2,000,000 (then $2 per 1M) | 2,000,000 (then $2 per 1M) | Custom |
| **Realtime Concurrent Connections** | 200 | 500 (then $10 per 1K peak) | 500 (then $10 per 1K peak) | Custom |
| **Realtime Messages** | 2,000,000/month | 5,000,000 (then $2.50 per 1M) | 5,000,000 (then $2.50 per 1M) | Custom |
| **Max Message Size** | 256 KB | 256 KB | 256 KB | Custom |
| **API Requests** | Unlimited | Unlimited | Unlimited | Unlimited |

---

## 3. Features by Plan

### Free Plan
- Auth, Realtime, APIs
- Community support

### Pro Plan
- Everything in Free plan
- Email support
- Daily backups stored for 7 days
- 7-day log retention
- No project pausing
- Spend cap enabled by default to prevent runaway bills

### Team Plan
- Everything in Pro plan
- Higher MAU limits than Pro
- SSO (Single Sign-On)
- Audit logs
- Stronger support compared to Pro
- Same 100 GB quota and overage pricing as Pro

### Enterprise Plan
- Everything in Team plan
- SOC 2 Type II compliance
- HIPAA compliance (with BAA)
- Private VPC
- Regional replication
- Custom SLAs
- Point-in-Time Recovery (up to 28-day retention)
- SSO & custom domains
- Custom quotas
- Dedicated infrastructure

---

## 4. Overage Pricing

| Resource | Overage Rate (Pro Plan) |
|---|---|
| Database Egress | $0.09/GB after 250 GB |
| Cached Egress | $0.03/GB after 250 GB |
| Storage Egress | $0.09/GB after 250 GB |
| Storage Overage | $0.021/GB/month after 100 GB |
| Auth MAU | $0.00325 per additional MAU after 100,000 |
| Edge Function Invocations | $2.00 per additional 1,000,000 |
| Realtime Messages | $2.50 per additional 1,000,000 |
| Realtime Peak Connections | $10.00 per additional 1,000 |

---

## 5. Add-Ons

| Add-On | Cost | Details |
|---|---|---|
| **Compute — Micro (default on Pro)** | ~$12/month (covered by $10 credit) | 2-core shared ARM, 1 GB RAM |
| **Compute — Small** | $50/month | 2-core ARM, 2 GB RAM |
| **Compute — Full Range** | ~$12 to ~$2,800/month | From Micro to 12XL |
| **Point-in-Time Recovery (PITR)** | $100/month | 7-day retention; Enterprise unlocks up to 28-day |
| **Custom Domains** | $10/month | Per domain |
| **Database Branching** | $0.01344/branch/hour | Pay-per-use branching |
| **Advanced MFA** | $75/month | First project |
| **HIPAA Projects** | Custom | Available as paid add-on for Team or Enterprise |

---

## 6. Key Platform Features

| Feature | Description |
|---|---|
| **Database** | Full PostgreSQL (relational, SQL, OLTP) with extensions support and read replicas (early preview) |
| **Authentication** | Prebuilt auth/user management with 17+ social providers (Google, Facebook, Apple, Azure, Twitter, GitHub, GitLab, BitBucket, Discord, Keycloak, LinkedIn, Notion, Slack, Spotify, Twitch, WorkOS, Zoom) |
| **Storage** | S3-compatible object storage with bucket-based file management |
| **Edge Functions** | Serverless Deno-based functions running close to the user for reduced latency |
| **Realtime** | Subscribe to Postgres changes for real-time CRUD updates; includes Broadcast and Presence features |
| **Instant APIs** | Auto-generated REST and GraphQL APIs from your database schema |

---

## 7. Notable Details & Insights

| # | Insight |
|---|---|
| 1 | Spend cap enabled by default on Pro plan to prevent runaway bills |
| 2 | Free projects pause after 1 week of inactivity |
| 3 | API requests are unlimited on all plans |
| 4 | Supabase is open-source and community-maintained |
| 5 | CLI available for managing projects via command line |
| 6 | Provides Prometheus-compatible metrics endpoints for monitoring |
| 7 | Realistic production Pro plan baseline is ~$110–120/month when including dedicated Large compute |
| 8 | Supabase is often 30–50% cheaper than Firebase at scale due to resource-based vs per-operation pricing |

---

## 8. Sources

| # | URL |
|---|---|
| 1 | https://supabase.com/docs/guides/platform/billing-on-supabase |
| 2 | https://schematichq.com/blog/supabase-pricing |
| 3 | https://uibakery.io/blog/supabase-pricing |
| 4 | https://cotera.co/articles/supabase-pricing-guide |
| 5 | https://www.metacto.com/blogs/the-true-cost-of-supabase-a-comprehensive-guide-to-pricing-integration-and-maintenance |
| 6 | https://bejamas.com/hub/serverless-database/supabase |

---

*Report generated from `competitor_supabase.json` — researched on 2026-05-27.*