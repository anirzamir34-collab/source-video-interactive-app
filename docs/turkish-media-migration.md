# Türkçe medya migration kaydı

Tarih: 2026-10-02. Bu belge eski Gemini konuşma/çeviri ve satır başına Eleven v3 motorundan, kaynağa bağlı Scribe v2 → OpenAI sahne çevirisi → Eleven v4 Text-to-Dialogue → Forced Alignment → tek Türkçe miks akışına geçişi kaydeder. Görsel analiz ve gameplay bu medya sağlayıcısı değişikliğinden ayrıdır. Resmi endpoint/model kanıtları ve Turbo sınırı [sağlayıcı sözleşmesinde](turkish-media-api-contract.md) bulunur.

## Başlangıç ve geri dönüş referansları

| Referans | Tür | Gerçek commit |
| --- | --- | --- |
| `ac7bd6a` | İncelenen upstream temel sürüm | `ac7bd6abb6065e90a599013873e4fe78d75ab180` |
| `migration/videoquest-turkish-media-2026-10-02` | Migration çalışma branch'i | Oluşturulduğunda `ac7bd6abb6065e90a599013873e4fe78d75ab180` |
| `backup/videoquest-before-turkish-media-2026-10-02` | GitHub remote backup branch'i | `ac7bd6abb6065e90a599013873e4fe78d75ab180` |
| `backup/videoquest-upstream-ac7bd6a-2026-10-02` | Annotated tag | `ac7bd6abb6065e90a599013873e4fe78d75ab180` |
| `backup/videoquest-turkish-media-before-migration-2026-10-02` | Annotated tag | `ae0c7738829b0caf1fcc84e177c56a6eb033cc0d` |

Son tag'in commit'i doğrulanmış upstream snapshot'unun migration öncesi yedeğidir. Buradaki hashler Git commit hashleridir; annotated tag nesne hashleri değildir. Bu belge branch'in daha sonra ilerleyecek HEAD'ini sabit bir sürüm diye göstermez.

Eski `docs/dubbing-review-2026-09-22.md`, Eleven v3 kanal motorunun tarihsel incelemesiydi; güncel kullanım rehberi olarak kaldırılmıştır. Gerekirse kaynak geçmişinden okunabilir:

```sh
git show ac7bd6abb6065e90a599013873e4fe78d75ab180:docs/dubbing-review-2026-09-22.md
```

## Eski bağımlılık envanteri

Eski aktif akış, `public/app.js` içinde ses çıkarma/yükleme, Gemini ASR ve çeviri, ses atama, her replik için TTS isteği, birden fazla `Audio` kanalı ve oynatma sırasında saat düzeltmesini birleştiriyordu. Aşağıdaki liste eski sağlayıcı sözleşmelerini ve yeni akıştan çıkarılan bağımlılıkları ayırır. Dosya geçmişi gerektiğinde başlangıç commit'inde bulunur.

| Eski HTTP yolu | Eski görev | Yeni karşılığı |
| --- | --- | --- |
| `POST /api/dialogue-upload/start` | Bellekte tutulan yükleme oturumu başlatma | `POST /api/turkish-media/uploads/start` |
| `GET /api/dialogue-upload/:uploadId/status` | Eski kaynak/ses yükleme durumu | `GET /api/turkish-media/uploads/:id/status` |
| `GET /api/dialogue-upload/:uploadId/chunk/:chunkIndex/status` | Tek eski parçanın alınıp alınmadığı | Yeni status cevabındaki `receivedChunks` |
| `POST /api/dialogue-upload/:uploadId/chunk` | Header ile offset/index, eski geçici dosyaya yazma | `POST /api/turkish-media/uploads/:id/chunk/:index` |
| `POST /api/gemini-dialogue-analyze` | Gemini transcribe + çeviri + konuşmacı/duygu çözümleme | Yeni job: Scribe ve OpenAI aşamaları |
| `POST /api/gemini-dub-segment` | Gemini TTS ses ucu | Türkçe medya akışında kaldırılır; Gemini ses fallback'i yok |
| `POST /api/elevenlabs-status` | Tarayıcı anahtarıyla subscription ve voice kontrolü | Anahtarsız `GET /api/turkish-media/capabilities`; gerçek model/voice doğrulaması backend sağlayıcısında |
| `POST /api/elevenlabs-voice-plan` | Eski konuşmacı roster'ına katalog atama | `voice-mapping.js`, yeni job içinde |
| `POST /api/elevenlabs-dub-segment` | Eleven v3 satır TTS, base64 cevap | Eleven v4 Text-to-Dialogue, final dosya artifact'i |
| `GET /api/ai-usage-status` | Eski Gemini diyalog kotası ve dublaj bağımlılığı | Türkçe medya yapılandırması/job hataları; görsel Gemini anahtar kontrolü ayrı kalır |

| Eski modül veya alan | Bağımlılık / görev | Migration sınırı |
| --- | --- | --- |
| `lib/dialogue-media.js` | Yerel ses probe, eski MP3 hazırlama ve ASR pencere dosyaları | Merkezi `lib/turkish-media/audio.js` kullanılır |
| `lib/source-transcription-windows.js` | Pencere başına Gemini konuşma çözümleme, birleştirme ve coverage audit | Tam kaynak sesi için tek Scribe isteği ve canonical coverage |
| `lib/voice-allocation.js` | Eski cinsiyet/voice skorları ve kişi ataması | Canonical speaker ID ile yeni `voice-mapping.js` |
| `public/dub-speakers.js` | Legacy speaker roster ve voice plan doğrulaması | Yeni manifest/speaker mapping; saved-games artık bu modülü import etmez |
| `public/dub-overlap.js` | Eski çok kanallı sesin aktif replikleri ve sonu | Overlap source aralıklarında korunur, sunucuda mikslenir |
| `public/dubbing-queue.js` | Tarayıcı TTS istek kuyruğu | Backend limiter ve job aşamaları |
| `public/dubbing-scheduler.js` | Replik ses yaşam döngüsü ve eksik ses durumları | Job hazır olmadan final mix READY sayılmaz |
| `public/dubbing-audio.js` | Ayrı Audio kanalları, canlı kaynak ducking, rate/tail/clock düzeltmesi | Kaynak video saatini izleyen tek `Audio` |
| `public/dub-cache.js` | Legacy per-segment saved cache uyumluluğu | Gerçek final mix Blob + canonical manifest |
| `public/dialogue-integrity.js` | Eski zaman onarımı/normalize ve konuşma yardımcıları | Canonical kaynak kanıtı yeniden zamanlanmaz; bu dosyaya bağlı ortak gameplay yardımcıları yalnız gerçek ortak kullanım varsa korunur |
| `public/mp4-audio.js`, `public/media-limits.js` | Eski tarayıcı MP4 ses çıkarma yolu ve paylaşılan boyut sınırları | Medya upload tam yerel kaynağı kullanır; ortak medya sınırları diğer video yolları için korunur |
| `state.dialogue`, `dubCache`, `dubRequests`, `dubQueue`, `dubChannels`, `dubSegmentMetadata`, `dubSpeakerVoices` | Eski app konuşma, istek ve kanal state'i | `sourceTranscript`, `sourceContext` ve medya client manifest/state'i |
| `videoquest_elevenlabs_api_key`, `X-ElevenLabs-Key`, anahtar kaydet/test/sil UI'si | Tarayıcı ElevenLabs anahtarı | Kaldırılır; `ELEVENLABS_API_KEY` yalnız backend |
| Eski `subtitleToggleBtn`, `keepOriginalAudio` modu | Tek TR track ve canlı kaynak ses karıştırma | `subtitleTrack`: off/source_tr/dub_tr; sabit final mix |
| `dubBufferStatus`, retry/source-audio UI'si, sync kontrolleri | Playback kurtarma ve kullanıcı eşitlemesi | Yeni client/playback/job durumuna bağlanır; kaynak video seek hookları korunur |

Eski sağlayıcı HTTP davranışına doğrudan bağlı testler: `elevenlabs-contract`, `dialogue-provider-retry`, `dialogue-quota-guard`, `local-dialogue-source`, `source-transcription-coverage`, `dialogue-media`, `audio-character-context` ve eski `dubbing-save-contract`. Eski kanal motoru testleri: `dub-cache`, `dub-speakers`, `dubbing-queue`, `dubbing-scheduler`, `dubbing-playback`, `dub-indicator`. Bunların legacy üretim beklentileri yeni API/manifest testleriyle değiştirilir; bir dosyada gameplay hook testi varsa o davranış yeni client hook'uyla korunur. Test adlarında burada `.test.js` eki kısaltılmıştır.

Gameplay/media regresyonları bu migration ile kaldırılmaz: `adult-gameplay`, `adult-runtime-occurrence`, interaction/timeline/panel testleri, `source-choice-groups`, `scene-entry`, `scene-fragment-barrier`, `protagonist-ownership`, `sequence-integrity`, `player-navigation`, `playback-logic`, analysis gap/retry/recovery, URL download/range/cache, extractor/manifest ve saved-games testleri. Legacy ses motoruna ilişkin beklentilerinden ayrılarak aynı kaynak sınırlarını doğrularlar.

## Korunan video, gameplay ve deployment bağımlılıkları

`/api/gemini-storyboard-analyze`, Gemini görsel ikinci kontrolü, `/api/gemini-key-status`, `/api/external-health`, `/api/external-capabilities`, `/api/external-analyze`, `/api/resolve-video-url`, `/api/video-proxy`, login/logout ve `/health` korunur. Gemini yalnız görsel/oyun analizi içindir; Türkçe medya katmanı Gemini'yi ASR, çeviri veya TTS olarak kullanmaz.

`public/storyboard.js`, `adult-gameplay.js`, interaction modülleri, source-verified occurrence filtreleri, `video-download.js`, `video-range-stream.js` ve `url-video-cache.js` ortak kaynak video akışının parçalarıdır. İndirilen URL kaynağının tarayıcı IndexedDB cache'i 24 saattir; URL çözümleme sunucu metadata cache'i 20 dakikadır. Bunlar sağlayıcı medya artifact cache'iyle aynı depo değildir. Yerel videonun bytes'ı korunur; analiz kareleri ve backend upload bu kaynağı kullanır.

Paket envanteri başlangıçta: `@google/genai ^2.21.0`, `express ^5.1.0`, `ffmpeg-static ^5.2.0`, `multer ^2.0.2`, `youtube-dl-exec ^3.1.15`; dev dependency `fake-indexeddb ^6.2.5`. Yeni medya modülleri Node built-in API'leri ve `fetch` kullanır; ayrıca ElevenLabs/OpenAI SDK'sı gerektirmez. `@google/genai` görsel analiz için, multer storyboard/external dosya yüklemeleri için, yt-dlp video çözümleme için kalır.

`package.json` Node alt sınırı 20.3.0'dır; çalışma doğrulamaları Node 24 üzerinde yapılır. Render web service build `npm ci`, start `npm start`, port varsayılanı 10000, `/health` owner-auth dışında süreç kontrolüdür. Repoda Render Blueprint veya `.env.example` bulunmaz. CI `.github/workflows/reliability-tests.yml` Node 24, sistem FFmpeg ve `npm ci` ardından `npm test` kullanır. Browser smoke ayrı `.mjs` komutudur; npm test wildcard'ına dahil değildir.

## Yeni modül ve endpoint haritası

| Modül | Sorumluluk |
| --- | --- |
| `config.js` | Backend env, model sınırları, gizli veri taşımayan capability cevabı |
| `uploads.js` | En çok 2 GiB kaynak, en çok 10 MiB immutable chunk, duplicate checksum, atomik resume metadata, server SHA-256 ve kaynak lease |
| `jobs.js` | Disk job state, stage ilerlemesi, restart'ta interrupted state, retry/cancel, bir aktif full pipeline için job kuyruğu, public manifest/artifact tanımı |
| `routes.js` | Owner-auth altındaki job/upload uçları, artifact allowlist, Range dosya cevabı ve transfer lease |
| `http.js`, `errors.js` | Timeout, AbortSignal, bounded retry/backoff/jitter/Retry-After, safe error ve secret redaction |
| `elevenlabs.js` | Backend auth, canlı model/language/limit kontrolü, sayfalı voice kataloğu, Scribe/TTD/Forced Alignment |
| `translation.js` | OpenAI scene context, strict JSON schema, segment identity/count ve süreye uygun çeviri |
| `voice-mapping.js`, `pronunciation.js` | Her gerçek speaker için ayrı voice; kanıtlanmış gender sınırı; versioned dictionary locators |
| `model.js` | Canonical source transcript, hash'e bağlı segment/speaker ID, source context adapter, coverage assertions |
| `audio.js` | Merkezi FFmpeg/probe, source padding/offset, gerçek turn split, süre ayarı, gerçek Türkçe mix |
| `subtitles.js` | İki subtitle timeline, gerçek aligned word zamanları, UTF-8 SRT/WebVTT |
| `cache.js`, `limiter.js` | Atomik checksum'lı disk artifact/JSON cache, TTL/lease/single-flight ve sınırlı concurrency |
| `public/source-transcript.js` | Tarayıcıda canonical kaynağı mevcut gameplay'in originalText/startTime/endTime şekline uyarlama |
| `public/turkish-media-client.js` | Upload/resume/job polling, kaynak değişiminde cancel, tek final Audio, subtitle track, offline Blob |
| `public/app.js`, `index.html`, `styles.css` | Kaynak transcript'i görsel analiz context'ine bağlama, status/quality/track/export UI ve playback hookları |
| `public/saved-games.js`, `saved-games-ui.js` | Sanitized manifest + video/mix Blob; v2 backup ve async capture |

Sunucu modülleri `lib/turkish-media/` altındadır. API prefix'i `/api/turkish-media`:

| Method | Yol | Sonuç |
| --- | --- | --- |
| GET | `/capabilities` | Anahtarların varlığı, model adları ve fast capability; anahtar değeri içermez |
| GET | `/voices` | Kullanıcı eşleştirmesi için yalnız güvenli voiceId/name/gender/language katalog alanları |
| POST | `/uploads/start` | Disk resume oturumu / aynı client upload key'in var olan oturumu |
| GET | `/uploads/:id/status` | Tamamlanan chunk indeksleri ve toplam durum |
| POST | `/uploads/:id/chunk/:index` | `application/octet-stream` chunk; aynı indeks farklı bytes kabul edilmez |
| POST | `/jobs` | `uploadId`, outputs, qualityMode ve opsiyonel voice/context ile 202 job descriptor |
| GET | `/jobs/:id` | State, ilerleme, oluştuğunda canonical source transcript ve READY result |
| POST | `/jobs/:id/retry` | Tamamlanan cache aşamalarını kullanan resume |
| POST | `/jobs/:id/cancel` | Aktif provider/process işine AbortSignal |
| GET | `/jobs/:id/result` | READY manifest; hazır değilse 409 |
| GET | `/jobs/:id/artifacts/:name` | Allowlist: `mix.wav`, `source_tr.srt/.vtt`, `dub_tr.srt/.vtt`; gerçek dosya bytes/Range |

Provider REST yolları: `GET /v1/models`, `GET /v2/voices`, `POST /v1/speech-to-text`, `POST /v1/text-to-dialogue/with-timestamps`, `POST /v1/forced-alignment`. OpenAI çeviri yolu `/v1/chat/completions`. Bunların auth header'ları backend içinde oluşturulur; client provider URL'sine istek göndermez.

## Canonical kanıt ve zaman sınırları

Canonical transcript `version:1`, `source:{hash,duration}`, `language`, `speakers`, `utterances`, `audioEvents` taşır. Her utterance'ın değişmez `segmentId`, `speakerId`, `sourceText`, `sourceStart`, `sourceEnd` ve sağlayıcıdan gelen speech/spacing word metadata'sı bulunur. Provider speaker ID tam video isteği boyunca tek registry'ye map edilir. Segment ve speaker ID'leri tam kaynak hash'i ve deterministik index'ten oluşur. Kaynak süre tarayıcı body alanından alınmaz; server container/audio incelemesinden gelir.

Konuşma words'ı geçersizse veya kayıp translation/dub varsa istek görünür hata ile durur. `assertSegmentCoverage` her kaynak segmentini tam bir kez, aynı speaker ile ister; kaynak metin ve aralık değiştirilemez. Kaynaktaki gerçek tekrarlar, kısa yanıtlar, söz kesme ve overlap ayrı kalır. `sourceContextAdapter`, çeviri yokken `originalText/text` olarak kaynak metni verir; `textTr/turkishText` boş olur. Böylece İngilizce kaynak Türkçe metin diye etiketlenmez.

`source_tr`, Türkçe çeviriyi gerçek source utterance aralığında gösterir; tahmini word timestamp üretmez ve `words:[]` taşır. `dub_tr`, son süre/tempo ayarı yapılmış gerçek Türkçe ses bytes'ı + aynı Türkçe text üzerinde Forced Alignment word zamanlarını kullanır; bunlar source slot başlangıcı eklenerek mutlak video zamanına yerleştirilir. V4 native alignment debug/cache kanıtıdır; final subtitle word zamanının yerine geçirilmez. Cue'lar mobil okumaya uygun, noktalama sınırlarıyla en çok iki satır olarak hazırlanır; aynı anda konuşan farklı speaker cue'ları korunur. SRT/VTT UTF-8'dir.

Kaynak slotu aşan dub metni daha kısa çeviriyle yeniden üretim gerektirir; konuşma sonu kesilerek slot içine zorlanmaz. Hafif tempo ayarı en çok 1.08'dir ve gerçek çıktı tekrar ölçülür. Uzun bir utterance provider karakter sınırı nedeniyle birkaç üretim parçasına ayrılabilir; canonical utterance ID değişmez ve final dub sayısı kaynak utterance sayısına eşit kalır. TTD üretim sırası ile gerçek source overlap birbirine karıştırılmaz; her turn kendi source slot'una mikslenir.

Kaynak video oyuncunun saatidir. Client yalnız Türkçe mix Audio saatini video currentTime + syncOffset ile eşler; kaynak videoya dil sistemi adına seek yazmaz. Pause, seek, waiting/stall, ended, error, kaynak değişimi ve destroy eski ses/caption işlerini durdurur. Gameplay pozisyon/movement occurrence aralıkları ve `sourceVerified` kuralları aynı kaynak video üzerinde kalır.

## Cache, güvenlik ve iptal

Eski upload/key cache'i 30 dakika ve process memory'deydi. Eski Eleven v3 voice cache'i 10 dakika; base64 audio cache'i 30 dakika/en çok 72 entry; in-flight synthesis map'i memory'deydi. Yeni cache varsayılan 86400 saniye, en çok 24 saattir. Hash identity source SHA-256, pipeline version, model, language, çeviri sürümü/text, speaker voice, output format, dictionary ve aşamaya özgü parametreleri kapsar. Aynı kaynakta provider aşamaları yeniden kullanılabilir; URL yeniden indirmeyi önleyen browser source cache'i ayrı korunur.

Disk kökü `DUB_CACHE_DIRECTORY` altında `uploads/`, `jobs/`, `cache/` ve audio çalışma alanlarıdır. Kaynak upload tamamlanmadan job başlatılamaz. JSON ve artifact nesilleri atomik yayınlanır, JSON/artifact SHA-256 doğrulanır, bozuk/expired giriş hit sayılmaz. Büyük ses dosyaları `{path}` ile copy/stream hash yapılabilir; WAV/video bütünü cache yazmak için Node belleğine alınmaz. `getArtifactPath` kullanımında tüketim bitene kadar dış lease tutulur. Per-process kaynak/artifact lease'leri TTL temizliği sırasında aktif işleri korur.

UUID upload/job kimlikleri, 64 haneli cache key ve güvenli artifact filename/allowlist path traversal'ı engeller. Cache okuması düzenli dosya ve symlink sınırını kontrol eder. FFmpeg shell kullanmadan argv ile çağrılır, ağ protokolleri dosya girişi için açılmaz. Provider base URL'leri backend sabittir. Client artifact URL'si aynı origin ve `/api/turkish-media/` altında olmalı; credentials, query veya fragment kabul edilmez. Subtitle DOM'a `textContent` ile yazılır.

Yeni routes mevcut owner-auth middleware'inden sonra kurulur. Public capability/job cevapları API key, input disk yolu veya cache artifactKey içermez. Hata metinleri yapılandırılmış anahtarları ve Bearer/header token değerlerini maskeler. Saved/export sanitization URL, backend path, API key, secret/token/cookie/credential ve cache/job metadata alanlarını çıkarır; gerçek sourceText/çeviri/evidence korunur.

Client reset/source change/destroy eski generation'ı iptal eder; sonradan gelen kabul edilmiş job descriptor'ı da cancel edilir. Provider HTTP retry yalnız 429/5xx/ağ/süre aşımı için sınırlıdır; kalıcı 4xx hemen hata olur. FFmpeg timeout/cancel SIGTERM ardından gerektiğinde SIGKILL uygular ve süreç kapanmadan slot/dosya işi tamamlandı sayılmaz. Limiter kuyruktaki iptal edilmiş işi başlatmaz, aktif slotu task gerçekten settle olana kadar bırakmaz.

Jobs kuyruğu aynı process'te bir full pipeline çalıştırır; böylece farklı job'ların source extraction/Scribe işleri sınırsız paralel başlamaz ve bir job'ın iptali başka job'ın ortak provider isteğini sahiplenmez. Tek pipeline içindeki scene çeviri/üretim paralelliği `DUB_MAX_CONCURRENCY` ile sınırlıdır. Kaynak dosya lease'i job kuyrukta beklerken de tutulur; provider-stage ve completed-segment cache yolları dosyayı kullanan pipeline boyunca lease taşır.

Bu sürüm tek Node process'inin yerel disk deposudur. Single-flight, upload kilitleri ve lease'ler process belleğindedir; aynı disk kökünü birden fazla process/instance paylaşmak için dağıtık kilit yoktur. Restart'ta cache/job/upload metadata okunur, yarım artifact yayınları hit olmaz; nonterminal persisted job `JOB_INTERRUPTED` ve retryable FAILED olur. Provider işi restart sonrası kendiliğinden sürmez; kullanıcı retry ile tamamlanan aşamaları kullanır. `/tmp` ephemeral deployment'ta restart/redeploy disk verilerini kaybedebilir; kalıcı resume gerekiyorsa tek instance'a bağlı persistent disk ve `DUB_CACHE_DIRECTORY` ayarlanmalıdır. Cleanup 10 dakika arayla çalışır; TTL bir background job schedule garantisi değildir.

## Ortam değişkenleri

| Değişken | Varsayılan / kullanım |
| --- | --- |
| `APP_PASSWORD`, `PORT` | Mevcut owner-auth; port 10000 |
| `EXTERNAL_ANALYSIS_URL` | Mevcut harici görsel analiz servisi |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Yalnız görsel/gameplay analizi; storyboard model default `gemini-3.8-flash` |
| `VIDEO_RESOLUTION_PROBE_URL`, `VIDEO_RESOLUTION_PROBE_UNTIL` | Mevcut tek başlangıç video çözümleme teşhisi, geçici kullanım |
| `ELEVENLABS_API_KEY` | Backend Scribe/voice/model/TTD/alignment anahtarı; transcript-only için de gerekli |
| `ELEVENLABS_STT_MODEL` | `scribe_v2`; başka model yapılandırılırsa başlangıç hatası |
| `ELEVENLABS_DUB_MODEL` | `eleven_v4`; eski modele fallback yok |
| `ELEVENLABS_FAST_MODEL` | `eleven_v4_turbo`; protocol gate açılmaz |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128`; final mix gerçek WAV dosyasıdır |
| `ELEVENLABS_PRONUNCIATION_DICTIONARY_ID`, `ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID` | İkisi birlikte veya ikisi boş; versioned provider dictionary |
| `TRANSLATION_PROVIDER` | `openai`; Gemini seçimi kabul edilmez |
| `OPENAI_API_KEY`, `TRANSLATION_MODEL` | Backend scene translation; model default `gpt-4.1-mini` |
| `TRANSLATION_VERSION` | `scene-tr-v1`; prompt/çeviri politika değişikliği cache kimliğini yeniler |
| `DUB_DEFAULT_LANGUAGE` | `tr` |
| `DUB_QUALITY_MODE` | `quality`; `fast` resmi WS gate'i nedeniyle görünür hata verir |
| `DUB_MAX_CONCURRENCY` | Tek aktif job içindeki sahne/aşama paralelliği 2, kabul edilen 1–8; full pipeline job kuyruğu 1 |
| `DUB_CACHE_DIRECTORY` | `/tmp/videoquest-turkish-media` |
| `DUB_CACHE_TTL` | 86400 saniye, kabul edilen 60–86400; upload deposunun varsayılanı ayrıca 24 saat |
| `DUB_REQUEST_TIMEOUT_MS` | 120000 ms, kabul edilen 1000–600000 |
| `DUB_MAX_RETRIES` | 3, kabul edilen 0–5; ilk isteğe ek bounded retry |

Eski `GEMINI_TRANSCRIBE_MODEL`, `GEMINI_DIALOGUE_MODEL`, `GEMINI_TTS_MODEL` ve `KEEP_GEMINI_FILES` yeni Türkçe medya akışının ayarları değildir; eski audio/translation deploy ayarları kaldırılmalıdır. Tarayıcı Gemini session anahtarı görsel analiz için ayrı kalabilir; ElevenLabs ve OpenAI anahtarı için frontend giriş/storage/header yolu yoktur.

## Saved-game ve .vqgame v2

IndexedDB `videoquest-saved-games` version 2, mevcut `games`, `payloads`, `videos` object store'larını korur ve `mixes` ekler. Save/delete dört store'un aynı transaction'ında yapılır; quota/write hatasında yarım kayıt oluşmaz. Source video ve görsel analiz dönüştürülmez. Top-level `dubAudio` gerçek Blob'dur; metadata'daki URL'den restore edilmez.

```js
turkishMedia = {
  manifest: {
    version: 1,
    sourceTranscript,
    translatedUtterances,
    voiceMapping,
    dubSegments,
    subtitles: { source_tr, dub_tr },
    assets: { mix: { mimeType, duration } },
    qualityReport
  },
  dubEnabled,
  subtitleTrack,
  syncOffset
};
```

`.vqgame` v2 layout: 8 byte `VQGAME2\n`, 4 byte big-endian UTF-8 JSON header uzunluğu, JSON header, `videoSize` kaynak video bytes, `mixSize` mix bytes. MIME bilgileri `videoType/mixType` içindedir. Header sınırı 128 MiB, uzunluklar ve tam dosya boyutu birlikte doğrulanır. Yeni mix base64 JSON olarak yazılmaz. Sadece source/analysis kayıtlarında `mixSize=0` olabilir. Import yeni oyun ID'si oluşturur; başka kaydı overwrite etmez.

V1 `VQGAME1\n` yedeklerinin kaynak videosu, görsel analizi ve izin verilen tarihsel kaynak konuşma metadata'sı kabul edilir; eski generated audio, base64 segment cache, voice plan ve oynatma state alanları girişte yok sayılıp atılır. `turkishMedia/dubAudio` null kalır; eski `payload.dubbingEnabled` alanı da taşınmaz. Mevcut v1 disk kayıtları sadece okunurken destructively overwrite edilmez; dönen DTO, sonraki save ve v2 export eski audio alanlarını taşımaz. Yeni Türkçe ses istenirse kaydedilmiş kaynak video üzerinden yeni job çalıştırılır.

Shelf `dialogueCount` canonical source utterance sayısı, `dubCount` canonical dub segment sayısıdır. “Dublaj kayıtlı” yalnız pozitif gerçek mix bytes ile görünür; eski base64 cache sayısı bu etiketi açmaz. `totalBytes=videoBytes+mixBytes`. `setSyncOffset` hook adı korunur ve `turkishMedia.syncOffset` güncellenir. Save/export async capture, client `materializeAudio()` ile bir kez gerçek mix Blob'u alır; offline restore object URL ile oynatılır, süresi dolmuş artifact URL'si kullanılmaz.

## QA kapsamı ve kalan sınırlar

Yeni regresyonlar: `turkish-media-core` (canonical coverage/subtitle/cache/limiter), `turkish-media-request` (retry/timeout/redaction), `turkish-media-elevenlabs` (resmi provider shape, model/language/format/capability), `turkish-media-pipeline` (kimlik/sayı, overlap, cache/retry/cancel, duration ve alignment), `turkish-media-audio` (mock process ve ortam izin verirse gerçek FFmpeg), `turkish-media-client` (source clock, caption, seek/pause/reset/stale job, Blob), `source-transcript`, `turkish-media-app` ve saved-games/UI testleri. HTTP route/auth/Range/upload kontrolleri mevcut HTTP testlerine bağlanır. Test toplamları aktif branch ve çalıştırılan ortamla değişir; bu belge eski README/STABILITY_REPORT sayısını güncel sonuç olarak tekrarlamaz.

Bu belgenin saved migration doğrulamasında syntax kontrolü ve `git diff --check` geçti; source-only v1 import temizliği dahil saved testleri 21 testte 14 passed, 0 failed, 7 skipped idi. Skip nedeni `fake-indexeddb` kurulu olmamasıydı; IndexedDB transaction/upgrade regresyonları kurulu dependency ortamında ayrıca çalıştırılmalıdır. Tüm migration için nihai test sayısı gerçek son test çıktısıyla raporlanır.

- Fast mod: Eleven v4 Turbo'nun varlığı resmi skills'de doğrulanır; erişilebilen resmi kaynaklar tam yeni Text-to-Dialogue WebSocket URL/protokolünü vermedi. `FAST_MODEL_PROTOCOL_UNVERIFIED` görünürdür, REST kaliteye veya eski TTS WebSocket'e sessiz fallback yapılmaz.
- Konuşmacı/cinsiyet: Scribe `speaker_id`, word timing ve logprob sağlar; cinsiyet/duygu kanıtı sağlamaz. `speaker_0` erkek diye atanmaz. Doğrulanmış kaynak metadata veya kullanıcı eşleşmesi olmadan otomatik kadın/erkek doğruluğu vaat edilmez; voice katalog gender label'ı kaynak kişisinin kanıtı değildir. Male protagonist önceliği görsel gameplay kuralıdır, ASR speaker sırası değildir.
- Arka plan/SFX: Varsayılan speech-ducking, konuşma dışındaki gerçek kaynak sesi korur; source konuşma aralıklarında kaynak sesini sıfırlar. Böylece orijinal dil sızmaz, ancak aynı aralıktaki gerçek müzik/SFX/ambience de kaybolabilir. Ayrıştırılmış gerçek background verilmeden aynı anda konuşma + ambience tam korunmuş sayılamaz; kaynakta olmayan SFX üretilmez.
- FFprobe: Sistem `/usr/bin/ffprobe` varsa container metadata kullanılır; yoksa merkezi servis FFmpeg header/decode sample sayımına geçer. Human-readable video header süresi yüzdelik saniyeye yuvarlanabilir; exact container tail doğruluğu için production FFprobe bulunması gerekir. `ffmpeg-static` FFprobe sağlamaz. Provider compressed bitrate süre tahmini dub ölçümü olarak kabul edilmez.
- Canlı sağlayıcı: Mock contract testleri actual hesabın model erişimi, Türkçe ses doğallığı, kaynak konuşmacı ayrım doğruluğu veya pronunciation dictionary uyumluluğunu kanıtlamaz. Bu migration sırasında ücretli Scribe/TTD/alignment/OpenAI deneme çağrısı yapılmadı. Gerçek credential/erişim ve kaynakla dinleme QA'sı tamamlanmış diye gösterilmez.
- Tarayıcı: `saved-games-browser.smoke.mjs` Playwright/Chromium ve FFmpeg gerektiren opsiyonel source save/restart/replay/backup smoke'udur; provider çağrısı yapmaz ve final Türkçe mix'i gerçek mobil codec/autoplay davranışıyla ayrıca doğrulamaz. Mock client testleri Android/iOS audio policy yerine geçmez.
- Disk/concurrency: Local single-flight ve lease'ler cross-process koordinasyon değildir. Çok instance ile ortak cache diski kullanımı ayrıca tasarlanmalıdır; disk kapasitesi/kota ve büyük kaynakların biriktirdiği derived WAV depolaması deployment'ta ölçülmelidir.

Son QA'da gerçek kaynağın hash'i, source/translations/dubs tam ID/speaker/sayı eşitliği, actual mix süresi ve clipping, overlap, Forced Alignment kelimeleri, seek/pause/loop/panel akışı, her iki UTF-8 subtitle export'u, v1/v2 import ve offline mix playback birlikte değerlendirilir. Görsel kaynak kanıtı, `sourceVerified:false` seçilememe ve occurrence movement izolasyonu medya üretimi başarısıyla gevşetilmez.

## Nihai CI doğrulaması

Kod commit'i `b3dce68` için [GitHub Actions run 36950798205](https://github.com/anirzamir34-collab/source-video-interactive-app/actions/runs/36950798205) temiz `npm ci` ve tam `npm test` geçti: **741 test, 741 pass, 0 fail, 0 skip**. Production JavaScript syntax: **52 dosya**. Önceki yerel bağımlılık skip'leri bu nihai tam sonucun yerine kullanılmaz. Ayrıntılı dosya/build/env/remaining/deploy raporu: [Implementation report](turkish-media-implementation-report.md).
