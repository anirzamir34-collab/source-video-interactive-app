# VIDEOQUEST Türkçe medya migration uygulama raporu

Tarih: 2026-10-02. İlk migration kaydı: [PR #103](https://github.com/anirzamir34-collab/source-video-interactive-app/pull/103), kod commit'i `a3e2e95091882b255eef325958bb6d6d9f708011`. Dosya sayıları, diffstat ve 744-test CI kaydı o commit'e aittir. Güncel `fix/browser-elevenlabs-gemini-2026-10-02` düzeltmesi çeviriyi Gemini'ye taşır, tarayıcı ElevenLabs anahtarını destekler ve OpenAI gereksinimini kaldırır. Aşağıdaki fast/production kalite sınırları giderilmiş sayılmıyor.

## 1. Oluşturulan dosyalar (31)

- `docs/turkish-media-api-contract.md`
- `docs/turkish-media-migration.md`
- `lib/turkish-media/audio.js`
- `lib/turkish-media/cache.js`
- `lib/turkish-media/config.js`
- `lib/turkish-media/elevenlabs.js`
- `lib/turkish-media/errors.js`
- `lib/turkish-media/http.js`
- `lib/turkish-media/jobs.js`
- `lib/turkish-media/limiter.js`
- `lib/turkish-media/model.js`
- `lib/turkish-media/pipeline.js`
- `lib/turkish-media/pronunciation.js`
- `lib/turkish-media/routes.js`
- `lib/turkish-media/subtitles.js`
- `lib/turkish-media/translation.js`
- `lib/turkish-media/uploads.js`
- `lib/turkish-media/voice-mapping.js`
- `public/source-transcript.js`
- `public/turkish-media-client.js`
- `scripts/check-syntax.js`
- `test/source-transcript.test.js`
- `test/turkish-media-app.test.js`
- `test/turkish-media-audio.test.js`
- `test/turkish-media-client.test.js`
- `test/turkish-media-core.test.js`
- `test/turkish-media-elevenlabs.test.js`
- `test/turkish-media-pipeline.test.js`
- `test/turkish-media-request.test.js`
- `test/voice-mapping.test.js`
- `docs/turkish-media-implementation-report.md`

## 2. Değiştirilen dosyalar (26)

- `README.md`
- `package.json`
- `public/app.js`
- `public/index.html`
- `public/media-limits.js`
- `public/panel-cinema.css`
- `public/playback-logic.js`
- `public/saved-games-ui.js`
- `public/saved-games.js`
- `public/styles.css`
- `public/url-video-cache.js`
- `server.js`
- `test/client-stability.test.js`
- `test/dub-indicator.test.js`
- `test/fixtures/interaction-timeline.js`
- `test/http-stability.test.js`
- `test/interaction-integration.test.js`
- `test/playback-logic.test.js`
- `test/player-navigation.test.js`
- `test/saved-games-ui.test.js`
- `test/saved-games.test.js`
- `test/server-stability.test.js`
- `test/source-media-coverage.test.js`
- `test/url-video-cache.test.js`
- `test/video-download.test.js`
- `test/video-manifest.test.js`

Production entegrasyonu yalnız konuşma/çeviri/ses/altyazı ve gerekli player/save sınırlarına bağlıdır. Gemini storyboard, video resolver/proxy/HLS/DASH, occurrence/movement sahipliği ve kaynak doğrulama kuralları korundu. Normal seçimler artık dublaj bitişini beklemek yerine kendi gerçek `action.endTime` sınırında biter. Yalnız görsel analiz istendiğinde ASR arızası kare analizini durdurmaz; önceki konuşma kanıtı temizlenir, istenen Türkçe medya hataları açık kalır. Kullanıcı iptali görsel devam başlatmaz ve arayüzü `CANCELLED/IDLE` durumuna döndürür.

## 3. Silinen legacy dosyalar (29)

- `docs/dubbing-review-2026-09-22.md`
- `lib/dialogue-media.js`
- `lib/source-transcription-windows.js`
- `lib/voice-allocation.js`
- `public/dialogue-integrity.js`
- `public/dub-cache.js`
- `public/dub-overlap.js`
- `public/dub-speakers.js`
- `public/dubbing-audio.js`
- `public/dubbing-queue.js`
- `public/dubbing-scheduler.js`
- `public/mp4-audio.js`
- `test/audio-character-context.test.js`
- `test/dialogue-integrity.test.js`
- `test/dialogue-media.test.js`
- `test/dialogue-provider-retry.test.js`
- `test/dialogue-quota-guard.test.js`
- `test/dialogue-timestamps.test.js`
- `test/dialogue-timing-integrity.test.js`
- `test/dub-cache.test.js`
- `test/dub-speakers.test.js`
- `test/dubbing-playback.test.js`
- `test/dubbing-queue.test.js`
- `test/dubbing-save-contract.test.js`
- `test/dubbing-scheduler.test.js`
- `test/elevenlabs-contract.test.js`
- `test/local-dialogue-source.test.js`
- `test/mp4-audio.test.js`
- `test/source-transcription-coverage.test.js`

Silinen testler eski sağlayıcı/queue/segment scheduler uygulamasını sınayan testlerdir. Kaynak süre/kapsamı, oynatma gezinmesi, source choices, interaction/panel, upload, HTTP ve saved-game regresyonları yeni sözleşmeye taşındı veya korundu. Kullanılmayan npm paketi yoktu; kalan bağımlılıkların görsel analiz, upload veya video ingestion kullanım referansları devam eder.

## 4. Yeni mimari

`SOURCE VIDEO → FFmpeg extraction → Scribe v2 diarization → canonical transcript → contextual duration-aware Gemini Turkish translation → stable speaker voices → Eleven v4 Text-to-Dialogue → actual duration fit → Forced Alignment → source_tr/dub_tr JSON + SRT + WebVTT → normalized final mix → source-clock player`.

Üretim tek pipeline'dır. `segmentId` her aşamada korunur; kaynak konuşma, gösterim metni ve gerçek dub word timing ayrı alanlardır. Kaynak örtüşmesi bağımsız üretim ve kaynak zamanlarında mikslenir. Uzun konuşma parçaları kelime/cümle sınırından ayrılıp aynı kaynak segmentine birleşir. Hiçbir yeni model hatası eski TTS/STT/provider'a fallback yapmaz.

24 saatlik hash cache; disk upload/job resume; per-turn generation ve completed-segment cache; async kaynak/artifact lease; tek video iş kuyruğu ve config ile sınırlı sahne/turn işleri; kontrollü 429/5xx/timeout retry bulunur. Tamamlanan parçalar aynı credential kapsamıyla retry sırasında tekrar sentezlenmez. Model, ses eşlemesi, metin, çeviri sürümü, ilgili ayarlar ve etkin sağlayıcı anahtarlarının SHA-256 kapsamı cache kimliğine dahildir; ham anahtar saklanmaz.

Job QA: source duration/language/speakers, source/translated/generated utterance counts, missing dub count, subtitle cue count, alignment success rate, cache hits, ElevenLabs physical request count, retry count ve failed segment IDs. Eksik kaynak segmentli çıktı READY olmaz. Bu rapor gerçek bir kullanıcı videosunun dil/dinleme QA'sı değildir; kaynak video ve provider credentials bu oturumda verilmedi.

## 5. ElevenLabs modelleri

- STT: `scribe_v2`; diarization, word timestamps, automatic source language, audio event metadata, verbatim seçenekleri.
- Final kalite: `eleven_v4`; doğrulanmış Text-to-Dialogue REST sözleşmesi ve uygulanan `/v1/models` model/Türkçe capability kontrolü.
- Fast preview: `eleven_v4_turbo` config'de ayrılmıştır fakat resmî yeni Text-to-Dialogue WebSocket URL/protokolü erişilebilir kaynaklarda doğrulanamadığı için **kapalıdır**. Fast implementasyonu tamamlandı diye gösterilmez.
- Forced Alignment: ayrı `/v1/forced-alignment`, gerçek fitted Türkçe ses + aynı metin; v4 STT yerine kullanılmaz.

Resmî kaynak/commit/parametre kanıtları: [API contract](turkish-media-api-contract.md). SDK'nın eski model enum'u yeni modelin yokluğu olarak yorumlanmadı; runtime model/dil ve request boyutları denetlenir.

## 6. Environment variables

Güncel akışta tarayıcı ElevenLabs parola alanına anahtarı yazmak ve server `GEMINI_API_KEY` fallback'ini kullanmak yeterlidir; ayrıca “Kullan” işlemi veya `OPENAI_API_KEY` gerekmez. Opsiyonel kullanıcı Gemini anahtarı server anahtarına önceliklidir. Backend `ELEVENLABS_API_KEY` yalnız fallback'tir. `APP_PASSWORD` erişim kontrolü korunur. ElevenLabs browser anahtarı parola alanı/geçici bellekte kalır; mevcut Gemini session davranışı korunur. Provider anahtarları capabilities/voices/create/retry header'larıyla backend'e iletilir ve job JSON/cache/result/saved/export/log'a yazılmaz. Restart retry aynı anahtarları yeniden ister; farklı anahtarla yeni create eski hesabın hazır cache'ini açmaz.

Merkezi config: `DUB_QUALITY_MODE=quality`, `ELEVENLABS_DUB_MODEL=eleven_v4`, `ELEVENLABS_FAST_MODEL=eleven_v4_turbo`, `ELEVENLABS_STT_MODEL=scribe_v2`, `ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128`, `DUB_MAX_CONCURRENCY=2`, `DUB_CACHE_TTL=86400`, `DUB_DEFAULT_LANGUAGE=tr`, `TRANSLATION_PROVIDER=gemini`, `TRANSLATION_VERSION=scene-tr-gemini-v2`. Çeviri model önceliği `TRANSLATION_MODEL` → `GEMINI_MODEL` → `gemini-3.8-flash`. Ek directory/timeout/retry ve opsiyonel pronunciation dictionary ayarlarının tamamı [README](../README.md) tablosundadır.

Eski `GEMINI_TRANSCRIBE_MODEL`, `GEMINI_DIALOGUE_MODEL`, `GEMINI_TTS_MODEL`, `KEEP_GEMINI_FILES` kullanılmaz. `GEMINI_API_KEY`/`GEMINI_MODEL` görsel analiz ve yeni canonical çeviri için kullanılır; ASR/TTS ElevenLabs'tadır. Eski `TRANSLATION_PROVIDER=openai` override'ı artık kabul edilmez. Varsayılanlar için yeni zorunlu deployment altyapısı eklenmedi.

## 7. Test sonuçları

Tarayıcı anahtarı düzeltmesinin standalone regresyonu production değişikliğinden önce test-only commit `dce2767409a6188e2ad7ed34e0257e5c66437e4a` ile yayınlandı ve **4/4 fail** verdi. Aynı test düzeltme sonrasında **4 pass, 0 fail, 0 skip** verdi: yalnız request ElevenLabs + server Gemini, kullanıcı Gemini override'ı, restart'ta credential yeniden sağlama/cache resume ve yanlış anahtarla account cache izolasyonu. Gerçek jobs/ElevenLabs/Gemini/canonical/cache/Forced Alignment adapter'ları kullanılır; ağ ve audio helper stub'dır. Disk job/cache, sonuç ve stage loglarında secret bulunmadığı ve OpenAI URL'sine hiç istek gitmediği denetlenir. Bu focused sonuç aşağıdaki tarihsel tam CI sayısına eklenerek yeni bir tam test toplamı diye gösterilmez.

[GitHub Actions run 36952599947](https://github.com/anirzamir34-collab/source-video-interactive-app/actions/runs/36952599947), son kod commit'i `a3e2e95`:

- Temiz `npm ci`: **başarılı**.
- Tam `npm test`: **744/744 geçti; 0 fail, 0 skip**.
- Bütün 52 production JavaScript dosyasının syntax kontrolü: **başarılı**.
- Gerçek Express auth/upload/artifact Range, IndexedDB v2/v1 import, gerçek FFmpeg/FFprobe ve source video/interaction/playback regresyonları kurulu bağımlılık ortamında çalıştı.
- Ücretli sağlayıcı endpoint'leri test doubles ile sınanır. Test geçmesi canlı hesabın erişimini veya Türkçe dinleme doğallığını kanıtlamaz.

Yerel sandbox'ta `npm ci` network EPERM ile engellendi ve bir gerçek HTTP benchmark'ı loopback listen EPERM verdi. Bu ortam sınırlamaları nedeniyle nihai tam test sonucu mevcut CI'dan alındı; dependency eksikliği skip olarak başarıya çevrilmedi. Son yerel focused testte 148 pass, 0 fail ve `fake-indexeddb` yokluğundan 7 skip vardı; CI aynı kayıt/DB testlerini skip etmeden geçirdi.

## 8. Build sonucu

Repository ayrı bundle/build/lint komutu tanımlamaz. İlk migration commit'inde Render build komutu olan `npm ci` CI'da başarılıydı; `npm run check` 52 production dosyayı doğruladı ve `npm test` bunu da çalıştırdı. Bu tarihsel CI kaydı sonraki provider/key düzeltmesinin tam CI sonucu değildir. Güncel deployment doğrulaması `/health.deploymentCommit` ile hedef SHA'yı karşılaştırır; model/config alanları canlı sağlayıcı erişimini kanıtlamaz.

## 9. Kalan bilinen problemler / doğrulama sınırları

- **Fast mode bekliyor:** yeni v4 Turbo WebSocket sözleşmesi olmadan URL/mesaj şeması tahmin edilmedi.
- **Kaynak ses cinsiyeti otomatik doğrulanmıyor:** Scribe gender sağlamaz. Sabit mapping ve manuel katalog seçimi vardır; belirsiz source speaker erkek/kadın diye uydurulmaz.
- **Speech ducking gerçek stem separation değildir:** konuşma sırasında orijinal konuşmayla birlikte müzik/SFX de kesilir. Ayrılmış gerçek background desteği audio helper'ındadır; mevcut ürün pipeline'ı harici background kabul etmez. Otomatik vocal separation eklenmedi.
- **Live listening QA yapılmadı:** whisper/arka plan ASR doğruluğu, çeviri doğallığı/semantik sadakat, v4/TR erişimi, pronunciation dictionary uyumluluğu ve gerçek Android/iOS fullscreen/audio policy production kaynakla kontrol edilmelidir.
- **FFprobe:** exact container duration için production'da bulunması gerekir; yoksa FFmpeg header fallback 0.01 saniye hassasiyetindedir.
- **Abonelik/maliyet:** WAV açık format hatasında aynı model MP3 kullanılır. Sağlayıcı idempotency garantisi doğrulanmadığından yanıtı kaybolmuş ücretli HTTP retry'sinin ikinci kez ücretlendirilmesini kesin önleme garantisi verilmez.
- **Disk/multi-instance:** cache ve lease tek process/same disk kapsamındadır; ephemeral disk kaybı resume'ı engeller. Ortak diskli çok instance için dağıtık kilit eklenmedi. Uzun full-video WAV disk tüketimi deployment'ta ölçülmelidir.
- **Uzun kaynak altyazısı:** Türkçe source-word zamanı uydurulmaz; aşırı uzun bir source cue iki satırda korunup warning taşıyabilir. Dub track gerçek alignment ile okunabilir parçalara bölünür.

## 10. Deployment doğrulama sınırı

İlk rapor PR #103 taslak aşamasında yazıldı; bu kayıt güncel PR/deploy durumunu bildirmez. Güncel sürüm `/health.deploymentCommit` hedef Git SHA ile eşleşerek doğrulanır. Gerçek key/model erişimi, FFprobe/disk ve kaynak videoyla Türkçe ses/iki altyazı/seek/fullscreen/konuşmacı dinleme QA'sı ayrı kanıt gerektirir. Mevcut Render secret'larıyla Gemini fallback korunur; browser ElevenLabs anahtarı backend ElevenLabs secret'ı gerektirmez. Fast tamamlanması ayrı resmî API sözleşmesini gerektirir; production-ready fast iddiası yoktur.

Rollback: `backup/videoquest-before-turkish-media-2026-10-02` remote branch'i `ac7bd6abb6065e90a599013873e4fe78d75ab180` commit'ini korur. Local annotated tag `backup/videoquest-upstream-ac7bd6a-2026-10-02` aynı commit'tedir; snapshot tag `backup/videoquest-turkish-media-before-migration-2026-10-02` aynı kaynak ağacını korur. Legacy kod yalnız Git geçmişinden geri alınır.

## İlk migration git diff --stat özeti

`86 files changed, 9062 insertions(+), 11017 deletions(-)`

Dosya bazlı tam değişiklik: PR #103 Files changed veya `git diff ac7bd6abb6065e90a599013873e4fe78d75ab180..HEAD --stat`.
