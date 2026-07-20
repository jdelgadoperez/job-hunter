# Changelog

## [0.6.1](https://github.com/jdelgadoperez/job-hunter/compare/job-hunter-v0.6.0...job-hunter-v0.6.1) (2026-07-13)


### Bug Fixes

* **cli:** job-hunter command fails on Windows with ERR_UNSUPPORTED_ESM_URL_SCHEME ([#146](https://github.com/jdelgadoperez/job-hunter/issues/146)) ([247a6df](https://github.com/jdelgadoperez/job-hunter/commit/247a6dfcb10787cbb5ab13fd0b6d649cfd34ab3b))

## [0.6.0](https://github.com/jdelgadoperez/job-hunter/compare/job-hunter-v0.5.0...job-hunter-v0.6.0) (2026-07-12)


### Features

* **cli:** graceful SIGINT/SIGTERM handling for serve & scan (C1) ([#143](https://github.com/jdelgadoperez/job-hunter/issues/143)) ([81f0d76](https://github.com/jdelgadoperez/job-hunter/commit/81f0d767a0b6f115f42e50270edc21eba42d51e7))
* **cli:** output & observability — --json, --verbose/DEBUG, stderr discipline (PR B) ([#142](https://github.com/jdelgadoperez/job-hunter/issues/142)) ([6e42947](https://github.com/jdelgadoperez/job-hunter/commit/6e4294755c0d97f86bf1c90c2af5e8658d593fe7))

## [0.5.0](https://github.com/jdelgadoperez/job-hunter/compare/job-hunter-v0.4.1...job-hunter-v0.5.0) (2026-07-11)


### Features

* **backend:** versioned Postgres migrations (supabase/migrations + CI apply + worker schema guard) ([#99](https://github.com/jdelgadoperez/job-hunter/issues/99)) ([ae535dd](https://github.com/jdelgadoperez/job-hunter/commit/ae535dd1f3a83640b96ba432ae9ba53b7442cd8d))
* **cli:** CLI best-practices quick wins (PR A) — engines, aliases, bug-report, injection-audit test ([#139](https://github.com/jdelgadoperez/job-hunter/issues/139)) ([bef1841](https://github.com/jdelgadoperez/job-hunter/commit/bef1841a7ad83bb3c3bd90ebc2adda63c8590fc0))

## [0.4.1](https://github.com/jdelgadoperez/job-hunter/compare/job-hunter-v0.4.0...job-hunter-v0.4.1) (2026-07-10)


### Bug Fixes

* **web:** confirm before Mark applied overwrites a saved posting ([#138](https://github.com/jdelgadoperez/job-hunter/issues/138)) ([793a4d5](https://github.com/jdelgadoperez/job-hunter/commit/793a4d5213157d55accc49b9dcd4362d2742864e))
* **web:** split confirmed vs unknown-location count in Matches ([#136](https://github.com/jdelgadoperez/job-hunter/issues/136)) ([aac565c](https://github.com/jdelgadoperez/job-hunter/commit/aac565c09ddc2a2c0f59a8928dad66c6676c5ccf))

## [0.4.0](https://github.com/jdelgadoperez/job-hunter/compare/job-hunter-v0.3.1...job-hunter-v0.4.0) (2026-07-09)


### Features

* **installer:** auto-install Node LTS when missing or too old ([#128](https://github.com/jdelgadoperez/job-hunter/issues/128)) ([c4ff100](https://github.com/jdelgadoperez/job-hunter/commit/c4ff100bdd3b7c27173274a7e6e89bbe97e9576b))


### Bug Fixes

* **web:** add clear-filters control to Matches view ([#134](https://github.com/jdelgadoperez/job-hunter/issues/134)) ([dbbe241](https://github.com/jdelgadoperez/job-hunter/commit/dbbe2418a528f96137f4e5b2a2ccd503a73a8a84))
* **web:** paginate the Matches list instead of rendering every card ([#135](https://github.com/jdelgadoperez/job-hunter/issues/135)) ([e12617d](https://github.com/jdelgadoperez/job-hunter/commit/e12617d61d6fcc1bff54ab4410b8e916773f22e2))

## [0.3.1](https://github.com/jdelgadoperez/job-hunter/compare/job-hunter-v0.3.0...job-hunter-v0.3.1) (2026-07-08)


### Bug Fixes

* **net:** stop waiting on networkidle for the whole render timeout ([#126](https://github.com/jdelgadoperez/job-hunter/issues/126)) ([35b7010](https://github.com/jdelgadoperez/job-hunter/commit/35b7010034c0628d21c0af9b51c54a21eed0729b))
* scan-worker crash and its silently-green CI report ([#124](https://github.com/jdelgadoperez/job-hunter/issues/124)) ([f4794a9](https://github.com/jdelgadoperez/job-hunter/commit/f4794a9144146f13f94fa1a870c3ca4ada311ccb))

## [0.3.0](https://github.com/jdelgadoperez/job-hunter/compare/job-hunter-v0.2.1...job-hunter-v0.3.0) (2026-07-07)


### Features

* **web:** show scan kind and last-run time on the Home "Last scan" card ([#121](https://github.com/jdelgadoperez/job-hunter/issues/121)) ([d66abb3](https://github.com/jdelgadoperez/job-hunter/commit/d66abb3dfabda3504b02ebf236c48cbd605e0393))

## [0.2.1](https://github.com/jdelgadoperez/job-hunter/compare/job-hunter-v0.2.0...job-hunter-v0.2.1) (2026-07-07)


### Bug Fixes

* **web:** correct update-banner copy and reuse service-restart in update scripts ([#119](https://github.com/jdelgadoperez/job-hunter/issues/119)) ([8754861](https://github.com/jdelgadoperez/job-hunter/commit/8754861a924dd43cf8ceb484ebc98c5b3d6b2915))

## [0.2.0](https://github.com/jdelgadoperez/job-hunter/compare/job-hunter-v0.1.0...job-hunter-v0.2.0) (2026-07-07)


### Features

* **backend:** add Postgres schema and Supabase RLS for the shared feed ([#51](https://github.com/jdelgadoperez/job-hunter/issues/51)) ([3c62890](https://github.com/jdelgadoperez/job-hunter/commit/3c62890cab135c3680ee4e0d6899e58f2b059582))
* **backend:** add the scheduled scanner worker entrypoint ([#56](https://github.com/jdelgadoperez/job-hunter/issues/56)) ([41c34ad](https://github.com/jdelgadoperez/job-hunter/commit/41c34add5611eeec7cabb857048d14e7d523951d))
* **backend:** PostgresScanStore implementing the ScanStore seam ([#52](https://github.com/jdelgadoperez/job-hunter/issues/52)) ([77354fe](https://github.com/jdelgadoperez/job-hunter/commit/77354fe52e505427952d55df6b6f6d165de5032f))
* background scan jobs with live status + scheduled refresh ([#12](https://github.com/jdelgadoperez/job-hunter/issues/12)) ([1e02642](https://github.com/jdelgadoperez/job-hunter/commit/1e02642e8b13d9e3d3c9aaf83393ccbc25a38f2f))
* **cli:** add `service restart` lifecycle action ([#111](https://github.com/jdelgadoperez/job-hunter/issues/111)) ([62d9a2c](https://github.com/jdelgadoperez/job-hunter/commit/62d9a2c545f9e7164cf47292440f49ab82297570))
* **cli:** add a `service` command for the background dashboard service ([#103](https://github.com/jdelgadoperez/job-hunter/issues/103)) ([9221026](https://github.com/jdelgadoperez/job-hunter/commit/922102669d8bdeebf1dc6c9508f46a337f19ada5))
* **cli:** add an optional `job-hunter` command on PATH ([#104](https://github.com/jdelgadoperez/job-hunter/issues/104)) ([2044b6a](https://github.com/jdelgadoperez/job-hunter/commit/2044b6a8f68e9ed7f8c393f5150f9f23c8e66089))
* cross-store companyId relational key + --retry-failed feed scoping ([#88](https://github.com/jdelgadoperez/job-hunter/issues/88)) ([53c3861](https://github.com/jdelgadoperez/job-hunter/commit/53c38616ee4db8bdbfda6452880e2ef479046d1a))
* deep-score with Claude from the dashboard ([#81](https://github.com/jdelgadoperez/job-hunter/issues/81)) ([b81470f](https://github.com/jdelgadoperez/job-hunter/commit/b81470f4c0bd923c240831f136aea008a3a2f893))
* **discovery:** add a remote PostingFeed client (PostgREST) ([#53](https://github.com/jdelgadoperez/job-hunter/issues/53)) ([3646f56](https://github.com/jdelgadoperez/job-hunter/commit/3646f563c582bf855b0939a1761963c8a7c14ad7))
* **discovery:** add a Rippling ATS connector ([#35](https://github.com/jdelgadoperez/job-hunter/issues/35)) ([3cad1ac](https://github.com/jdelgadoperez/job-hunter/commit/3cad1ac49220ac5d27d67eb07415356073ec9a0b))
* **discovery:** add a Workday ATS connector (72 directory companies) ([#31](https://github.com/jdelgadoperez/job-hunter/issues/31)) ([f35d345](https://github.com/jdelgadoperez/job-hunter/commit/f35d345a933c4844cd5b0e438345cf836bfbda04))
* **discovery:** add BambooHR, UKG, and Breezy ATS connectors ([#38](https://github.com/jdelgadoperez/job-hunter/issues/38)) ([cc041be](https://github.com/jdelgadoperez/job-hunter/commit/cc041beab7bd31b11c4911c24cad6d13d0f08297))
* **discovery:** add Recruitee and SmartRecruiters ATS connectors ([#37](https://github.com/jdelgadoperez/job-hunter/issues/37)) ([e0f2336](https://github.com/jdelgadoperez/job-hunter/commit/e0f2336681436867f73ff7c814f4ff0d72b2df1a))
* **discovery:** expandable lead sources (framework + Remotive + Workable) ([#47](https://github.com/jdelgadoperez/job-hunter/issues/47)) ([baffb3a](https://github.com/jdelgadoperez/job-hunter/commit/baffb3a97265e89309213a003c32f267df8f1c06))
* **discovery:** fetch full Workday job descriptions ([#33](https://github.com/jdelgadoperez/job-hunter/issues/33)) ([528a171](https://github.com/jdelgadoperez/job-hunter/commit/528a17158add02bed3e092a27cb16abeeec8050c))
* **discovery:** show the board host in per-company scan progress ([#74](https://github.com/jdelgadoperez/job-hunter/issues/74)) ([739b863](https://github.com/jdelgadoperez/job-hunter/commit/739b863d625311f694fb94aaeca615cd42e76a1a))
* **discovery:** size the ATS-behind-custom-domains opportunity ([#39](https://github.com/jdelgadoperez/job-hunter/issues/39)) ([#40](https://github.com/jdelgadoperez/job-hunter/issues/40)) ([e505c48](https://github.com/jdelgadoperez/job-hunter/commit/e505c488c80e73bd87e4cb716bf61b727f7d0c23))
* edit skills in the UI, broaden the default dictionary, default min score 50 ([#14](https://github.com/jdelgadoperez/job-hunter/issues/14)) ([ab136bc](https://github.com/jdelgadoperez/job-hunter/commit/ab136bcbb287a1fb853983d0b1ff4fcd82812300))
* filter matches by remote and country ([#76](https://github.com/jdelgadoperez/job-hunter/issues/76) A+B) ([#78](https://github.com/jdelgadoperez/job-hunter/issues/78)) ([d9081a4](https://github.com/jdelgadoperez/job-hunter/commit/d9081a44369bc1cd5b9e0b5e3d8baf511071ba0c))
* incremental scans — directory diff + posting expiry ([#17](https://github.com/jdelgadoperez/job-hunter/issues/17)) ([f773b96](https://github.com/jdelgadoperez/job-hunter/commit/f773b9679368aa7c928eabcbbae466a9638db299))
* local web server — job-hunter serve (Plan 5) ([#10](https://github.com/jdelgadoperez/job-hunter/issues/10)) ([42e6cd5](https://github.com/jdelgadoperez/job-hunter/commit/42e6cd51b0fb0e4feb98fd6d7346fba335e8aec4))
* **location:** home-country deep-score gate + Ashby hybrid fix ([#93](https://github.com/jdelgadoperez/job-hunter/issues/93)) ([2eb734a](https://github.com/jdelgadoperez/job-hunter/commit/2eb734aa52701cedfbd5e2f689213d9eea1fc372))
* mark a posting as applied so it stops resurfacing ([#63](https://github.com/jdelgadoperez/job-hunter/issues/63)) ([#79](https://github.com/jdelgadoperez/job-hunter/issues/79)) ([4d6b211](https://github.com/jdelgadoperez/job-hunter/commit/4d6b2115a4a6e66e4cf31e1440bcb36a73848f27))
* **matches:** add company research links to match cards ([#86](https://github.com/jdelgadoperez/job-hunter/issues/86)) ([109a796](https://github.com/jdelgadoperez/job-hunter/commit/109a79640535a01438138682f901e8435370e2d7))
* **matches:** add free-text search filter to the matches page ([#85](https://github.com/jdelgadoperez/job-hunter/issues/85)) ([f7a5670](https://github.com/jdelgadoperez/job-hunter/commit/f7a56706dbf2e9e1ea488b8b706d1910a31f0124))
* per-posting liveness re-checks + UI/UX & accessibility pass ([#20](https://github.com/jdelgadoperez/job-hunter/issues/20)) ([5e9bdff](https://github.com/jdelgadoperez/job-hunter/commit/5e9bdff489f48a3061976dba86a9e7a8a0537dab))
* pin the company directory to the community Airtable (remove as config) ([#13](https://github.com/jdelgadoperez/job-hunter/issues/13)) ([4da77e0](https://github.com/jdelgadoperez/job-hunter/commit/4da77e05c14816de93bca16bf8655d08b2d7ecca))
* React dashboard served by the local server (Plan 6) ([#11](https://github.com/jdelgadoperez/job-hunter/issues/11)) ([fcc8de3](https://github.com/jdelgadoperez/job-hunter/commit/fcc8de3a8428eafec9da33c9960333d81bac2d67))
* refined styling — web light/dark mode + top-tier CLI (color & help) ([#21](https://github.com/jdelgadoperez/job-hunter/issues/21)) ([8d7621f](https://github.com/jdelgadoperez/job-hunter/commit/8d7621fba6e3ec93d68aee367e3d2d1c112e58f2))
* run the dashboard as a background service (macOS + Windows) ([#77](https://github.com/jdelgadoperez/job-hunter/issues/77)) ([b7721a4](https://github.com/jdelgadoperez/job-hunter/commit/b7721a4d528ff27862036dfab2e50afa2d59b33f))
* save/dismiss matches + richer directory-diff & expired surfacing ([#19](https://github.com/jdelgadoperez/job-hunter/issues/19)) ([8c4632a](https://github.com/jdelgadoperez/job-hunter/commit/8c4632a8817a9b86d13109c5c6b02f219791b6d4))
* **scan:** hybrid remote mode — pull the shared feed + crawl tracked companies ([#55](https://github.com/jdelgadoperez/job-hunter/issues/55)) ([89676b0](https://github.com/jdelgadoperez/job-hunter/commit/89676b0f61e018e9bb532a9b10fa99554337255c))
* **scan:** incremental scan with configurable freshness ([#94](https://github.com/jdelgadoperez/job-hunter/issues/94)) ([8702548](https://github.com/jdelgadoperez/job-hunter/commit/87025486711da7edd57b38359082fc78d79a807b))
* **scan:** skip un-scrapable hosts + directory analysis + setup/install fixes ([#30](https://github.com/jdelgadoperez/job-hunter/issues/30)) ([9e0c4b7](https://github.com/jdelgadoperez/job-hunter/commit/9e0c4b71b14e2a232c68a7a5786fbc06de3a7cd4))
* **score:** live deep-score progress, re-score toggle, cap-order fix, Sonnet 5 default ([#91](https://github.com/jdelgadoperez/job-hunter/issues/91)) ([24cba99](https://github.com/jdelgadoperez/job-hunter/commit/24cba9949c0c755281fdee9d1f4bfdb4bb680d01))
* **score:** surface prompt-cache read/write split on the dashboard path ([#97](https://github.com/jdelgadoperez/job-hunter/issues/97)) ([3c40fb1](https://github.com/jdelgadoperez/job-hunter/commit/3c40fb13dde263b15a7deafda439467c17345278))
* skill type-ahead, track companies from the UI, richer scan progress ([#15](https://github.com/jdelgadoperez/job-hunter/issues/15)) ([ac25b91](https://github.com/jdelgadoperez/job-hunter/commit/ac25b915a8d641f6a634c073585764c414384859))
* smart follow-up scanning for warned companies ([#87](https://github.com/jdelgadoperez/job-hunter/issues/87)) ([dc75e83](https://github.com/jdelgadoperez/job-hunter/commit/dc75e83bda525f6bd8206ee8432d062be3d80db3))
* smooth updates — update script + "update available" nudge ([#18](https://github.com/jdelgadoperez/job-hunter/issues/18)) ([ea62938](https://github.com/jdelgadoperez/job-hunter/commit/ea629388a2bdc8878aeb90e3c19d9d6c5927a0e9))
* split scan into free scan + budget-safe score (heuristic-gated batch LLM) ([#46](https://github.com/jdelgadoperez/job-hunter/issues/46)) ([5641646](https://github.com/jdelgadoperez/job-hunter/commit/56416462f3411f488e0094fb703bdbfbcf20bb40))
* The Muse lead source + concurrent deep scoring ([#48](https://github.com/jdelgadoperez/job-hunter/issues/48)) ([67fd5c6](https://github.com/jdelgadoperez/job-hunter/commit/67fd5c63806d11cb0ddce390730b9e11bcb206ec))
* **web:** add favicons and web app manifest ([abb98e3](https://github.com/jdelgadoperez/job-hunter/commit/abb98e30b071bb0390869b4eef9ac849a34159c3))
* **web:** surface un-scrapable directory companies for manual review ([#32](https://github.com/jdelgadoperez/job-hunter/issues/32)) ([21d8c4c](https://github.com/jdelgadoperez/job-hunter/commit/21d8c4c26d3ec523aa6d371495762aff0a10af14))
* **web:** tune manifest colors to the dark theme canvas ([a207781](https://github.com/jdelgadoperez/job-hunter/commit/a2077814e5d8d61affac9ac003b735734cfa69a4))


### Bug Fixes

* 15 full-app review findings (deep-score gate, Postgres parity, SSRF tests, a11y, CLI, UX) ([#95](https://github.com/jdelgadoperez/job-hunter/issues/95)) ([2fe1e70](https://github.com/jdelgadoperez/job-hunter/commit/2fe1e7024cb081e652d1af9aebba6d1db279a75e))
* 5 must-fix findings from the full-app review (crawl budget, SSRF pin+redirect, crashed-scan expiry, dashboard errors) ([#100](https://github.com/jdelgadoperez/job-hunter/issues/100)) ([fde6753](https://github.com/jdelgadoperez/job-hunter/commit/fde675359f55d61b5985b8a9f8eb18975dd7cfb4))
* address six-agent UI/UX + code review findings ([#80](https://github.com/jdelgadoperez/job-hunter/issues/80)) ([310a466](https://github.com/jdelgadoperez/job-hunter/commit/310a46670e951ebd74cffb531551a79c8211ec66))
* **cli:** make `service restart` delegate to stop + start scripts ([#112](https://github.com/jdelgadoperez/job-hunter/issues/112)) ([64a0cb1](https://github.com/jdelgadoperez/job-hunter/commit/64a0cb1032a344f136600e5f847dd5fc6bd67c7c))
* **cli:** redraw the help banner bow (was facing backwards) ([#27](https://github.com/jdelgadoperez/job-hunter/issues/27)) ([7143ecc](https://github.com/jdelgadoperez/job-hunter/commit/7143ecc42570a3b66e4dbb6fc0cabe71697bc070))
* companies.id must be a non-unique index (serve crash on migrate) ([#90](https://github.com/jdelgadoperez/job-hunter/issues/90)) ([6d666bf](https://github.com/jdelgadoperez/job-hunter/commit/6d666bfa2e0e89b2cfb1ac80788d8504a28b6fd0))
* **discovery:** harden + self-diagnose the Airtable directory read ([#28](https://github.com/jdelgadoperez/job-hunter/issues/28)) ([a242995](https://github.com/jdelgadoperez/job-hunter/commit/a2429955edadd220100499918b97969986447309))
* **discovery:** repair the Airtable directory read (0 → 1,129 companies) ([#29](https://github.com/jdelgadoperez/job-hunter/issues/29)) ([9d493f4](https://github.com/jdelgadoperez/job-hunter/commit/9d493f49c0c04bb7a14493cdf344cd064de1e0bc))
* **location:** recognize explicit country signals + backfill posting country ([#92](https://github.com/jdelgadoperez/job-hunter/issues/92)) ([cea0b34](https://github.com/jdelgadoperez/job-hunter/commit/cea0b340b86d830355d83eedfee09a9f5850d633))
* **net:** SSRF guard — block discovery fetches to non-public addresses ([#25](https://github.com/jdelgadoperez/job-hunter/issues/25)) ([f356a03](https://github.com/jdelgadoperez/job-hunter/commit/f356a031c6e35379734492dfdb8c08939c9ccc99))
* normalize careers URLs and skill names before storage ([#83](https://github.com/jdelgadoperez/job-hunter/issues/83)) ([88ac788](https://github.com/jdelgadoperez/job-hunter/commit/88ac7885fbed05a60f6fcc32b51e4cae8b573a20))
* reliable browser step — one-command dev, scan logs, timeouts, setup warm-up ([#16](https://github.com/jdelgadoperez/job-hunter/issues/16)) ([adb1190](https://github.com/jdelgadoperez/job-hunter/commit/adb11906ebb55c632e1dc04ebe9e1ac6faca7fa5))
* **server:** bind dashboard to loopback + reject non-loopback Host headers ([#23](https://github.com/jdelgadoperez/job-hunter/issues/23)) ([5e39c88](https://github.com/jdelgadoperez/job-hunter/commit/5e39c88fbd3a29e257d24b1bf95098917c031962))
* **service:** point background-service scripts at the new default port 48373 ([#102](https://github.com/jdelgadoperez/job-hunter/issues/102)) ([89d352a](https://github.com/jdelgadoperez/job-hunter/commit/89d352ac932b45c13f681971fee7e3734f429202))
* **web:** link The Muse hint to the developer API page, not the homepage ([f065546](https://github.com/jdelgadoperez/job-hunter/commit/f065546fcccc90cc6aa59de858ed142643d3eeee))
* **worker:** budget the crawl so scan-worker never overruns its job timeout ([#96](https://github.com/jdelgadoperez/job-hunter/issues/96)) ([10e1e27](https://github.com/jdelgadoperez/job-hunter/commit/10e1e27a9672d68f913c40bb3be7ee0142fd7a0d))
* **worker:** self-heal Postgres schema drift on startup ([#98](https://github.com/jdelgadoperez/job-hunter/issues/98)) ([f274cf5](https://github.com/jdelgadoperez/job-hunter/commit/f274cf5090321cafd5a4c211396b021df62b4657))


### Performance Improvements

* **backend:** bulk-upsert postings in the Postgres scan store ([#61](https://github.com/jdelgadoperez/job-hunter/issues/61)) ([565b251](https://github.com/jdelgadoperez/job-hunter/commit/565b251a9f56246d54a84ea64ac116512acad98e))
* **scan:** concurrent posting scoring + add .nvmrc (Node 24) ([#26](https://github.com/jdelgadoperez/job-hunter/issues/26)) ([3f47551](https://github.com/jdelgadoperez/job-hunter/commit/3f47551a1b599a897021ba48a6b563edd47ce4f9))
