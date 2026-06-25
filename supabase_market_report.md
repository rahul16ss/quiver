# Supabase Market Report

> **Competitor:** Supabase  
> **Website:** [https://supabase.com](https://supabase.com)  
> **Pricing Page:** [https://supabase.com/pricing](https://supabase.com/pricing)  
> **Data Last Updated:** May 2026  
> **Billing Model:** Organization-based billing. Choose a plan for your organization; each project runs on its own compute instance. Plan subscription covers platform features and usage quotas. Compute is billed separately per project. Pro and Team plans include $10/month in compute credits (covers one Micro instance). Spend caps on by default on Pro plan.

---

## Table of Contents

1. [Pricing Plan Comparison](#1-pricing-plan-comparison)
2. [Resource Limits by Plan](#2-resource-limits-by-plan)
3. [Features by Plan](#3-features-by-plan)
4. [Overage Pricing](#4-overage-pricing)
5. [Compute Add-Ons](#5-compute-add-ons)
6. [Disk Storage Options](#6-disk-storage-options)
7. [Add-Ons](#7-add-ons)
8. [Key Platform Features](#8-key-platform-features)
9. [Regions](#9-regions)
10. [Notable Details](#10-notable-details)
11. [Sources](#11-sources)

---

## 1. Pricing Plan Comparison

| Feature | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| **Price** | $0/month | $25/month per project (includes $10 compute credit) | $599/month per project (includes $10 compute credit) | Custom (contact sales) |
| **Best For** | Hobby projects, experiments, development | Production apps, growing startups | Growing teams needing compliance & advanced access control | Large organizations, regulated industries, internet-scale workloads |
| **Active Projects** | 2 active (unlimited paused) | Unlimited | Unlimited | Unlimited |
| **Project Pausing** | After 1 week of inactivity | Never | Never | Never |
| **Spend Caps** | N/A | On by default | Configurable | Configurable |
| **Support** | Community | Community + Email | Community + Email + Email SLA + Security Questionnaire Help | Community + Email + Email SLA + Designated support + Onboarding + Customer Success Team + 24×7×365 + Private Slack |
| **Uptime SLA** | ❌ | ❌ | ❌ | ✅ |
| **SOC 2** | ❌ | ❌ | ✅ | ✅ |
| **ISO 27001** | ❌ | ❌ | ✅ | ✅ |
| **HIPAA** | ❌ | ❌ | Paid add-on | Paid add-on |
| **SSO (Dashboard)** | ❌ | ❌ | Contact Us | Contact Us |
| **Platform Audit Logs** | ❌ | ❌ | ✅ | ✅ |
| **AWS PrivateLink** | ❌ | ❌ | ✅ | ✅ |
| **BYO Cloud** | ❌ | ❌ | ❌ | ✅ |
| **Custom Domains** | ❌ | $10/domain/month | $10/domain/month | 1 included, then $10/domain/month |
| **Vanity URLs** | ❌ | ✅ | ✅ | ✅ |
| **Image Transformations** | ❌ | ✅ | ✅ | ✅ (Custom) |
| **Metrics Endpoint** | ❌ | ✅ | ✅ | ✅ |
| **Log Retention** | 1 day | 7 days | 28 days | 90 days |
| **Log Drains** | ❌ | $60/drain/mo + $0.20/M events + $0.09/GB egress | $60/drain/mo + $0.20/M events + $0.09/GB egress | Custom |
| **Pipelines** | ❌ | $39/pipeline/mo + $3/GB replicated + $0.60/GB backfill | $39/pipeline/mo + $3/GB replicated + $0.60/GB backfill | Custom |
| **Access Roles** | Owner, Admin, Developer | Owner, Admin, Developer | Owner, Admin, Developer, Read-only, Predefined scoped roles | Custom project scoped roles |

---

## 2. Resource Limits by Plan

| Resource | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| **Database Size** | 500 MB (Shared CPU, 500 MB RAM) | 8 GB included, then $0.125/GB | 8 GB included, then $0.125/GB | Custom |
| **Database Egress** | 5 GB | 250 GB included, then $0.09/GB | 250 GB included, then $0.09/GB | Custom |
| **Cached Egress** | 5 GB | 250 GB included, then $0.03/GB | 250 GB included, then $0.03/GB | Custom |
| **Auth MAUs** | 50,000 | 100,000 included, then $0.00325/MAU | 100,000 included, then $0.00325/MAU | Custom |
| **File Storage** | 1 GB | 100 GB included, then $0.0213/GB | 100 GB included, then $0.0213/GB | Custom |
| **Storage Egress** | 5 GB | Included in egress quotas | Included in egress quotas | Custom |
| **Edge Function Invocations** | 500,000 | 2,000,000 included, then $2/M | 2,000,000 included, then $2/M | Custom |
| **Realtime Connections** | 200 concurrent | 500 included, then $10/1,000 | 500 included, then $10/1,000 | Custom (volume discounts) |
| **Realtime Messages** | 2,000,000/month | 5,000,000 included, then $2.50/M | 5,000,000 included, then $2.50/M | Volume discounts |
| **Max Message Size** | 256 KB | 3 MB | 3 MB | Custom |
| **API Requests** | Unlimited | Unlimited | Unlimited | Unlimited |
| **Max File Upload Size** | 50 MB | 500 GB | 500 GB | Custom |
| **CDN** | Basic CDN | Smart CDN | Smart CDN | Smart CDN |

---

## 3. Features by Plan

### Database

| Feature | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| Dedicated Postgres | ✅ | ✅ | ✅ | ✅ |
| Unlimited API Requests | ✅ | ✅ | ✅ | ✅ |
| Advanced Disk Config | ❌ | ✅ | ✅ | ✅ |
| Custom Backups | ❌ | Daily (7 days) | Daily (14 days) | Custom |
| Point-in-Time Recovery (PITR) | ❌ | $100/mo per 7 days | $100/mo per 7 days | $100/mo per 7 days, >28 days available |
| Database Branching | ❌ | $0.01344/branch/hr | $0.01344/branch/hr | Custom |

### Authentication

| Feature | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| Unlimited Total Users | ✅ | ✅ | ✅ | ✅ |
| Anonymous Sign-ins | ✅ | ✅ | ✅ | ✅ |
| Social OAuth Providers | ✅ | ✅ | ✅ | ✅ |
| Custom SMTP Server | ✅ | ✅ | ✅ | ✅ |
| Basic MFA | ✅ | ✅ | ✅ | ✅ |
| Auth Hooks (Custom Access Token JWT, Send custom email/SMS) | ✅ | ✅ | ✅ | ✅ |
| Remove Supabase Branding (emails) | ❌ | ✅ | ✅ | ✅ |
| Leaked Password Protection | ❌ | ✅ | ✅ | ✅ |
| Single Session per User | ❌ | ✅ | ✅ | ✅ |
| Session Timeouts | ❌ | ✅ | ✅ | ✅ |
| Advanced MFA Phone | ❌ | $75/mo first project, $10/mo additional | $75/mo first project, $10/mo additional | Contact Us |
| SAML SSO | ❌ | 50 included, then $0.015/MAU | 50 included, then $0.015/MAU | Contact Us |
| Auth Hooks (All) | ❌ | ❌ | ✅ | ✅ |
| Advanced Security Features | ❌ | ❌ | Contact Us | Contact Us |

### Storage

| Feature | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| Custom Access Controls | ✅ | ✅ | ✅ | ✅ |
| Image Transformations | ❌ | 100 origin images included, then $5/1,000 | ✅ | Custom |
| Custom Storage | ❌ | ❌ | ❌ | ✅ |

### Realtime

| Feature | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| Postgres Changes | ✅ | ✅ | ✅ | ✅ |
| Volume Discounts | ❌ | ❌ | ❌ | ✅ |

---

## 4. Overage Pricing

Applies to Pro and Team plans (Free plan has hard caps):

| Resource | Included Quota | Overage Rate |
|---|---|---|
| Database Storage | 8 GB | $0.125 per GB |
| Database Egress | 250 GB | $0.09 per GB |
| Cached Egress | 250 GB | $0.03 per GB |
| Auth MAUs | 100,000 | $0.00325 per MAU |
| File Storage | 100 GB | $0.0213 per GB |
| Edge Function Invocations | 2,000,000 | $2.00 per 1 Million |
| Realtime Connections | 500 concurrent | $10.00 per 1,000 |
| Realtime Messages | 5,000,000 | $2.50 per Million |

---

## 5. Compute Add-Ons

All projects run on a compute instance. Pro and Team plans include Micro compute in the base price ($10/month credit). Compute is billed hourly.

| Size | Price/Month | CPU | Dedicated | RAM | Direct Connections | Pooler Connections |
|---|---|---|---|---|---|---|
| Micro | $10 | 2-core ARM | No | 1 GB | 60 | 200 |
| Small | $15 | 2-core ARM | No | 2 GB | 90 | 400 |
| Medium | $60 | 2-core ARM | No | 4 GB | 120 | 600 |
| Large | $110 | 2-core ARM | Yes | 8 GB | 160 | 800 |
| XL | $210 | 4-core ARM | Yes | 16 GB | 240 | 1,000 |
| 2XL | $410 | 8-core ARM | Yes | 32 GB | 380 | 1,500 |
| 4XL | $960 | 16-core ARM | Yes | 64 GB | 480 | 3,000 |
| 8XL | $1,870 | 32-core ARM | Yes | 128 GB | 490 | 6,000 |
| 12XL | $2,800 | 48-core ARM | Yes | 192 GB | 500 | 9,000 |
| 16XL | $3,730 | 64-core ARM | Yes | 256 GB | 500 | 12,000 |
| >16XL | Contact Us | Custom | Yes | Custom | Custom | Custom |

---

## 6. Disk Storage Options

| Attribute | General Purpose | High Performance |
|---|---|---|
| **Max Size** | 16 TB | 60 TB |
| **Included** | 8 GB included, then $0.125/GB | $0.195/GB (no included quota) |
| **IOPS** | 3,000 IOPS included, then $0.024/IOPS | $0.119/IOPS |
| **Throughput** | 125 MB/s included, then $0.095/MB/s | Scales automatically with IOPS |
| **Durability** | 99.9% | 99.999% |

---

## 7. Add-Ons

| Add-On | Pricing |
|---|---|
| Point-in-Time Recovery (PITR) | $100/month per 7 days retention |
| Custom Domain | $10 per domain per month per project |
| Database Branching | $0.01344 per branch per hour |
| Advanced MFA Phone | $75/month for first project, then $10/month per additional project |
| SAML SSO Auth | 50 included, then $0.015 per MAU |
| Log Drains | $60 per drain/month + $0.20 per million events + $0.09 per GB egress |
| Image Transformations | 100 origin images included, then $5 per 1,000 origin images |
| Pipelines | $39 per pipeline/month + $3.00 per GB replicated data + $0.60 per GB backfill data |
| HIPAA | Available as paid add-on on Team and Enterprise plans |

---

## 8. Key Platform Features

| # | Feature |
|---|---|
| 1 | PostgreSQL database with real-time capabilities |
| 2 | Auto-generated REST and GraphQL APIs |
| 3 | Authentication with social OAuth, magic links, phone auth, MFA, SAML SSO |
| 4 | File storage with CDN and image transformations |
| 5 | Edge Functions (Deno-based serverless functions) |
| 6 | Realtime subscriptions (Postgres changes, broadcasting) |
| 7 | Row-Level Security (RLS) enforced at database layer |
| 8 | pgvector for AI/vector similarity search (included free on all plans) |
| 9 | Database branching (Pro+) |
| 10 | Point-in-Time Recovery (Pro+) |
| 11 | Pipelines for data replication (Pro+) |
| 12 | Log drains (Pro+) |
| 13 | Custom domains and vanity URLs (Pro+) |
| 14 | Spend caps on by default (Pro plan) |
| 15 | Self-hosting available via Docker/CLI (free) |

---

## 9. Regions

**Infrastructure:** AWS  
**Total Regions:** 17

| # | Location | Region | AWS ID |
|---|---|---|---|
| 1 | US East (North Virginia) | North America | us-east-1 |
| 2 | US East (Ohio) | North America | us-east-2 |
| 3 | US West (North California) | North America | us-west-1 |
| 4 | US West (Oregon) | North America | us-west-2 |
| 5 | Canada (Central) | North America | ca-central-1 |
| 6 | São Paulo | South America | sa-east-1 |
| 7 | Ireland | Europe | eu-west-1 |
| 8 | London | Europe | eu-west-2 |
| 9 | Paris | Europe | eu-west-3 |
| 10 | Frankfurt | Europe | eu-central-1 |
| 11 | Zurich | Europe | eu-central-2 |
| 12 | Stockholm | Europe | eu-north-1 |
| 13 | Mumbai | Asia Pacific | ap-south-1 |
| 14 | Singapore | Asia Pacific | ap-southeast-1 |
| 15 | Tokyo | Asia Pacific | ap-northeast-1 |
| 16 | Seoul | Asia Pacific | ap-northeast-2 |
| 17 | Sydney | Asia Pacific | ap-southeast-2 |

---

## 10. Notable Details

- All plans include unlimited API requests
- Free projects auto-pause after 1 week of inactivity (limit 2 active projects)
- Pro and Team plans include $10/month compute credit (covers one Micro instance)
- Spend caps on by default on Pro plan to prevent unexpected bills
- pgvector (vector database for AI) included free on all plans
- Self-hosting available for free via Docker or Supabase CLI
- Organization-based billing: plan applies to org, compute billed per project
- Pricing is in Beta and may change in the future
- Pro plan charged upfront monthly; additional usage billed at end of month
- Email notifications sent when within 20% of plan limits
- No cold starts — instances stay active for consistent latency
- IPv6 required for direct connections unless IPv4 add-on is enabled

---

## 11. Sources

| # | Source | URL |
|---|---|---|
| 1 | Supabase Official Pricing Page | [https://supabase.com/pricing](https://supabase.com/pricing) |
| 2 | UIBakery — Supabase Pricing in 2026 | [https://uibakery.io/blog/supabase-pricing](https://uibakery.io/blog/supabase-pricing) |
| 3 | Schematic — Supabase Pricing Page and Costs Explained (2026) | [https://schematichq.com/blog/supabase-pricing](https://schematichq.com/blog/supabase-pricing) |
| 4 | Srvrlss — Supabase Pricing, Features & Alternatives | [https://www.srvrlss.io/provider/supabase](https://www.srvrlss.io/provider/supabase) |
| 5 | Metacto — Supabase Pricing 2026: Complete Cost Breakdown | [https://www.metacto.com/blogs/the-true-cost-of-supabase-a-comprehensive-guide-to-pricing-integration-and-maintenance](https://www.metacto.com/blogs/the-true-cost-of-supabase-a-comprehensive-guide-to-pricing-integration-and-maintenance) |
| 6 | Bytebase — Supabase vs AWS: Feature and Pricing Comparison (2026) | [https://www.bytebase.com/blog/supabase-vs-aws-pricing](https://www.bytebase.com/blog/supabase-vs-aws-pricing) |
| 7 | MakerKit — Supabase Pricing Calculator (2026) | [https://makerkit.dev/pricing-calculator/supabase](https://makerkit.dev/pricing-calculator/supabase) |
| 8 | Flexprice — Supabase Pricing Breakdown | [https://flexprice.io/blog/supabase-pricing-breakdown](https://flexprice.io/blog/supabase-pricing-breakdown) |

---

*Report generated from `competitor_supabase.json` — data current as of May 2026.*