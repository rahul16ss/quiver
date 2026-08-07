# Model Router — Native-Document vs Text-Only Routing (ADR-001 §5)

Native ingestion still requires a passed contract test for the MIME
(`CapabilityRegistry`, §6). The router selects a *candidate* native-doc
profile; `QuiverOpenRouterClient.invoke` then re-checks `isCertifiedFor` and
fails closed if the profile is uncertified for that exact MIME — a PDF pass on
`claude-sonnet-5` does not authorize DOCX ingestion on the same profile.
