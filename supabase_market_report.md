# Supabase Market Report

> **Product:** Supabase  
> **Category:** Backend-as-a-Service (BaaS)  
> **Research Date:** 2025-01-24  
> **Description:** Supabase is an open-source backend-as-a-service platform and Firebase alternative. It provides a PostgreSQL database, authentication, file storage, instant APIs, edge functions, and realtime capabilities in a unified platform.

---

## Table of Contents

1. [Pricing Plan Comparison](#1-pricing-plan-comparison)
2. [Feature Comparison by Plan](#2-feature-comparison-by-plan)
3. [Compute Add-Ons](#3-compute-add-ons)
4. [Paid Add-Ons](#4-paid-add-ons)
5. [Key Platform Features](#5-key-platform-features)
6. [Notable Details & Competitive Positioning](#6-notable-details--competitive-positioning)
7. [Sources](#7-sources)

---

## 1. Pricing Plan Comparison

| Attribute | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| **Price** | $0/month | $25/month per project (includes $10 compute credit) | $25/month per project (usage-based scaling) | Custom pricing |
| **Target Audience** | Hobbyists, prototyping, MVPs | Production applications, startups | Small teams, growing startups | Large-scale applications, enterprises |
| **Active Projects** | 2 | 1+ (per-project billing) | 1+ (per-project billing) | Custom |
| **Database Size** | 500 MB (shared CPU) | 8 GB per project | Same as Pro | Custom |
| **Database Egress** | 5 GB/month | 250 GB included ($0.09/GB overage) | Same as Pro | Custom |
| **Cached Egress** | 5 GB/month | 250 GB included ($0.03/GB overage) | Same as Pro | Custom |
| **Auth MAUs** | 50,000 | 100,000 included ($0.00325/additional MAU) | Higher than Pro | Custom |
| **File Storage** | 1 GB | 100 GB included ($0.021/GB/month overage) | Same as Pro | Custom |
| **Storage Egress** | 5 GB/month | 250 GB included ($0.09/GB overage) | Same as Pro | Custom |
| **Edge Function Invocations** | 500,000 | 2,000,000 ($2 per additional 1M) | Same as Pro | Custom |
| **Realtime Connections** | 200 concurrent | 500 peak ($10 per additional 1,000) | Same as Pro | Custom |
| **Realtime Messages** | 2,000,000/month | 5,000,000 ($2.50 per additional 1M) | Same as Pro | Custom |
| **Max Message Size** | 256 KB | 256 KB | 256 KB | Custom |
| **API Requests** | Unlimited | Unlimited | Unlimited | Unlimited |
| **Backups** | ❌ None | ✅ Daily backups (7-day retention) | ✅ Daily backups (7-day retention) | ✅ PITR (up to 28-day retention) |
| **Log Retention** | ❌ | 7 days | 7 days | Custom |
| **SSO** | ❌ | ❌ | ✅ | ✅ |
| **Audit Logs** | ❌ | ❌ | ✅ | ✅ |
| **SOC 2 / HIPAA** | ❌ | ❌ | ❌ (HIPAA available as add-on) | ✅ SOC 2 Type II, HIPAA |
| **Custom Domains** | ❌ | ❌ | ❌ (add-on available) | ✅ |
| **Private VPC** | ❌ | ❌ | ❌ | ✅ |
| **Regional Replication** | ❌ | ❌ | ❌ | ✅ |
| **SLA** | ❌ | ❌ | ❌ | ✅ Custom SLAs |
| **Spend Cap** | N/A | ✅ Enabled by default | ✅ | Custom |
| **Support** | Community | Email | Stronger than Pro | Priority |

---

## 2. Feature Comparison by Plan

### 2.1 Free Plan Limitations

| Limitation | Details |
|---|---|
| No automated backups or PITR | Manual exports only |
| No SOC 2 / HIPAA compliance | Not suitable for regulated industries |
| No SSO | Single sign-on not available |
| No SLAs or priority support | Community support only |
| Project pausing | Projects pause after 1 week of inactivity |
| Organization members | Limited to 1 member |

### 2.2 Pro Plan Highlights

| Feature | Details |
|---|---|
| Spend cap | Enabled by default to prevent runaway bills |
| Daily backups | Stored for 7 days |
| Log retention | 7-day retention |
| Compute credit | $10/month included (offsets Micro tier cost) |
| Support | Email support |

### 2.3 Team Plan Highlights

| Feature | Details |
|---|---|
| SSO | Single Sign-On support |
| Audit logs | Available |
| Support | Stronger than Pro plan |
| Quotas & overage | Same 100 GB quota and overage pricing as Pro |

### 2.4 Enterprise Plan Highlights

| Feature | Details |
|---|---|
| Compliance | SOC 2 Type II, HIPAA |
| Infrastructure | Private VPC, Regional replication |
| PITR | Point-in-Time Recovery (up to 28-day retention) |
| SSO & Custom Domains | Full support |
| SLA | Custom SLAs |
| Deployment | Custom quotas and private cloud deployment |
| Support | Priority support |

---

## 3. Compute Add-Ons

| Compute Tier | Specs | Cost |
|---|---|---|
| Micro (default on Pro) | 2-core ARM, 1 GB RAM | ~$12/month (covered by $10 credit) |
| Small | 2-core ARM, 2 GB RAM | $50/month add-on |
| Large | Higher compute | Varies (realistic production baseline ~$110–120/month) |
| 12XL | Maximum compute | ~$2,800/month |

> ⚠️ **Note:** The Pro plan's $25/month base price uses the Micro compute tier. For production workloads, upgrading to the Large tier brings the realistic monthly cost to ~$110–120/month.

---

## 4. Paid Add-Ons

| Add-On | Cost | Notes |
|---|---|---|
| Point-in-Time Recovery (PITR) | $100/month (7-day retention) | Enterprise plan supports up to 28-day retention |
| Custom Domains | $10/month | Available on Team/Enterprise |
| Database Branching | $0.01344/branch/hour | Pay-per-use for ephemeral branches |
| Advanced MFA | $75/month (first project) | Enhanced multi-factor authentication |
| HIPAA Projects | Custom pricing | Team or Enterprise plans only |

---

## 5. Key Platform Features

| Feature | Description |
|---|---|
| **PostgreSQL Database** | Full PostgreSQL database with extensions support, table-oriented relational data model |
| **Authentication** | Prebuilt auth/user management with social providers: Google, Facebook, Apple, Azure (Microsoft), Twitter, GitHub, GitLab, BitBucket, Discord, Keycloak, LinkedIn, Notion, Slack, Spotify, Twitch, WorkOS, Zoom |
| **Realtime** | Subscribe to Postgres changes in real-time, broadcast messages to multiple clients, track user presence and online status |
| **Storage** | S3-compatible object storage with storage buckets — eliminates need for separate S3 integration |
| **Edge Functions** | Serverless Deno-based functions running close to users for reduced latency; best suited for lightweight serverless logic |
| **Instant APIs** | Auto-generated REST and GraphQL APIs from your database schema |
| **CLI** | Supabase CLI for local development and project management |
| **Monitoring** | Web dashboard with Prometheus-compatible metrics endpoints for health insights |

---

## 6. Notable Details & Competitive Positioning

| Insight | Details |
|---|---|
| Open-source | Community-maintained platform |
| Firebase alternative | Uses SQL (PostgreSQL) instead of NoSQL |
| Spend cap protection | Enabled by default on Pro plan to prevent unexpected bills |
| Generous free tier | One of the most generous in the BaaS space |
| Cost vs Firebase | Typically 30–50% cheaper than Firebase at scale (resource-based vs per-operation pricing) |
| Cost vs AWS | Equivalent AWS setup estimated at $80–120/month vs $25 Pro plan |
| Project pausing | Free plan projects pause after 1 week of inactivity |
| Realistic production cost | Pro plan baseline is ~$110–120/month when including dedicated Large compute |

---

## 7. Sources

| # | URL |
|---|---|
| 1 | https://supabase.com/docs/guides/platform/billing-on-supabase |
| 2 | https://schematichq.com/blog/supabase-pricing |
| 3 | https://uibakery.io/blog/supabase-pricing |
| 4 | https://cotera.co/articles/supabase-pricing-guide |
| 5 | https://www.metacto.com/blogs/the-true-cost-of-supabase-a-comprehensive-guide-to-pricing-integration-and-maintenance |
| 6 | https://bejamas.com/hub/serverless-database/supabase |

---

*Report generated from `competitor_supabase.json` on 2025-01-24.*