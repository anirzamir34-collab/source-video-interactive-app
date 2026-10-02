# Source Video Interactive App

Yerel dosya veya uzak video kaynağı üzerinde zaman damgalı analiz, etkileşimli video oynatma, Türkçe altyazı ve dublaj sunan Node.js/Express uygulaması.

## Çalıştırma ve doğrulama

Node.js 20.3 veya üzeri gerekir. Migration kontrolleri Node.js 24.19.0 ile çalıştırılır; güncel sonuçlar migration raporunda belirtilir.

```sh
npm ci
npm test
npm start
```

Başlatmadan önce `APP_PASSWORD` tanımlanmalıdır. Tanımlı değilse uygulama erişime açılmaz. `PORT` varsayılanı 10000'dir. Canlı ortamda HTTPS kullanılmalıdır; oturum çerezi `Secure` ve `HttpOnly` olarak oluşturulur.

`npm test`, sözdizimi denetimlerini, mevcut oynatıcı/analiz regresyonlarını, hata senaryolarını ve gerçek Express HTTP entegrasyonunu çalıştırır. HTTP testleri geçici bir yerel sunucu ve test parolası kullanır; ücretli model veya ses servislerine çağrı yapmaz.

## Bileşenler

| Bileşen | İşlev |
|---|---|
| `server.js` | Oturum doğrulama, kaynak çözümleme ve aktarım, parça yükleme, analiz ve ses sağlayıcı uçları |
| `public/app.js` | Analiz yönetimi, video kaynağı yaşam döngüsü, altyazı ve dublaj senkronizasyonu |
| `public/storyboard.js` | Video örnekleme ve storyboard karelerinin hazırlanması |
| `public/analysis-recovery.js` | Analiz hatalarının sınıflandırılması ve yeniden deneme kuralları |
| `public/playback-logic.js`, `public/engine-hardening.js`, `public/story-engine.js` | Zaman çizelgesi, analiz doğrulama ve oynatma yardımcıları |

Hareket analizi Gemini storyboard uçlarını kullanır. `/api/external-analyze` ayrıca yapılandırılmış harici servise dosya iletir. Kaynak konuşma bilgisi görsel analize yalnızca özgün metin ve kaynak zamanlarıyla aktarılır; Türkçe ses veya hizalama zamanları etkileşimli seçimlerin kanıtı değildir. Seçim oynatımı kendi doğrulanmış kaynak aralığında biter.

## TURKISH DUBBING PIPELINE

```text
SOURCE VIDEO → FFmpeg extraction → Scribe v2 + diarization
→ canonical source transcript → contextual OpenAI Turkish translation
→ stable speaker/voice mapping → Eleven v4 Text-to-Dialogue
→ real duration fitting → ElevenLabs Forced Alignment
→ source_tr + dub_tr (JSON/SRT/WebVTT) → normalized final mix → video player
```

Her aşama `lib/turkish-media/` altında ayrı modüldür. `segmentId` kaynak konuşmadan çeviri, ses, hizalama ve altyazıya kadar korunur. Scribe cevabındaki bütün kelime ve ses olayı verileri saklanır; gösterim metni özgün transcript'i değiştirmez. Konuşma atlanması, eksik API konuşma haritası veya eksik hizalama kelimesi işi `FAILED` yapar. Başarılı sonuçta QA raporunun `missingDubCount` değeri 0 olmalıdır.

Çeviri bütün sahne grubunu, önceki/sonraki konuşmaları ve her kaynak süreyi görür. OpenAI sağlayıcısı yapılandırılabilir; Gemini yalnız görsel analizde kalır. Gerçek ses uzun gelirse aynı konuşma için daha kısa çeviri ve yeniden üretim denenir; en fazla 1.08 tempo düzeltmesi uygulanır, ses kesilmez. Uzun diyaloglar API'nin canlı karakter sınırına göre cümle/kelime sınırında bölünüp aynı kaynak segmenti altında birleştirilir. Kaynakta örtüşen konuşmalar kendi aralıklarında korunur.

**Model seçimi:** varsayılan `quality` modu `eleven_v4`, transcription `scribe_v2` kullanır. Canlı ElevenLabs model listesinde model ve Türkçe (`tr`) desteği doğrulanmadan sentez gönderilmez. `fast` için `eleven_v4_turbo` ayrılmıştır; erişilebilir resmî kaynaklar yeni Text-to-Dialogue WebSocket URL/protokolünü açıklamadığı için bu mod şimdilik kapalıdır ve `FAST_MODEL_PROTOCOL_UNVERIFIED` döndürür. Eski model veya sağlayıcıya fallback yoktur. Doğrulanan sözleşmeler: [API contract](docs/turkish-media-api-contract.md).

Konuşmacı kimliği video boyunca sabittir; her konuşmacı farklı bir sese eşlenir ve eşleme manifest/kayıt içinde saklanır. Scribe ses cinsiyetini bildirmez: belirsiz kimlikler için otomatik atama aynı sesi korur fakat doğru kadın/erkek eşleşmesini kanıtlamaz. Konuşmacı sesleri arayüzden seçilebilir ve aynı kaynak cache'i kullanılarak yeniden üretilebilir. API anahtarları yalnız sunucudadır; voice ID'leri gizli anahtar değildir ve katalogdan sağlanır.

**Altyazılar:** `source_tr`, Türkçe metni özgün konuşma aralığında gösterir; Türkçe kelimelere tahmini zaman uydurmaz. `dub_tr`, üretilmiş ve süreye uydurulmuş gerçek Türkçe ses üzerindeki Forced Alignment zamanlarını kullanır. Dublaj açıkken varsayılan `dub_tr` olur. İki kanal UTF-8 SRT/WebVTT ve internal JSON olarak üretilir. Seek/pause/replay/fullscreen tek altyazı görünümünü video saatinden günceller. Kaynakta eşzamanlı konuşan kişiler ayrı satırlarda gösterilebilir.

**Miks:** merkezi FFmpeg servisi kaynak sesini stereo 48 kHz WAV olarak korur, Türkçe sesleri kaynak zamanlarına yerleştirir ve clipping'i sınırlar. Hazır ayrılmış background track verilirse kullanılabilir. Varsayılan `speech-ducking` orijinal konuşma aralıklarında kaynak sesi susturur: çift dil engellenir, fakat o aralıktaki müzik ve efektler de zayıflar. Bu yöntem gerçek konuşma/müzik ayrıştırması değildir; QA raporunda miks yöntemi görünür. PCM isteği, kanal sayısı tahmin edilmeden aynı sample rate'te belgelenmiş headerlı WAV isteğine dönüştürülür. Hesap formatı açıkça reddederse aynı modelde MP3 kullanılır.

**Cache ve işler:** 24 saatlik disk cache; video SHA-256, model, metin, voice mapping, çeviri sürümü, format ve ilgili ayarlar ile anahtarlanır. Hazır aşamalar ve segmentler hemen kaydedilir; retry tamamlanan ücretli aşamaları yeniden çağırmaz. Aynı kaynak dosya chunk yüklemesi restart sonrası sürdürülebilir; URL video cache'i aynı videonun yeniden indirilmesini önler. Aktif dosyalar lease ile temizlemeden korunur; işler tek video sırasından, sahneler sınırlı eşzamanlılıkla yürür. Disk farklı sunucular arasında paylaşılmaz; yerel cache process lease'leri dağıtık değildir. Mevcut kaynak URL resolver/deployment değiştirilmedi.

Frontend `PREPARING_AUDIO`, `TRANSCRIBING`, `DIARIZING`, `TRANSLATING`, `GENERATING_DUB`, `ALIGNING`, `BUILDING_SUBTITLES`, `MIXING_AUDIO`, `READY`, `FAILED` durumlarını gösterir; iptal ve retry vardır. 429/5xx/network/timeout kontrollü backoff + jitter ile tekrar edilir. Sağlayıcının doğrulanmış idempotency desteği olmadığı için yanıtı kaybolan bir ücretli HTTP isteğinin yeniden ücretlendirilmesini kesin olarak önleme garantisi yoktur; tamamlanan aşama cache'i ve single-flight gereksiz tekrarları azaltır.

### Yapılandırma

| Değişken | Varsayılan / kullanım |
|---|---|
| `APP_PASSWORD` | Zorunlu uygulama giriş parolası |
| `PORT` | `10000` |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Yalnız storyboard/görsel analiz; mevcut tarayıcı Gemini anahtar seçimi korunur |
| `EXTERNAL_ANALYSIS_URL` | İsteğe bağlı harici analiz servisi |
| `ELEVENLABS_API_KEY` | Sunucu secret; transcription/dublaj/hizalama/katalog |
| `OPENAI_API_KEY` | Sunucu secret; Türkçe çeviri |
| `DUB_QUALITY_MODE` | `quality`; `fast` sözleşme doğrulanana kadar kapalı |
| `ELEVENLABS_DUB_MODEL` | `eleven_v4` |
| `ELEVENLABS_FAST_MODEL` | `eleven_v4_turbo` |
| `ELEVENLABS_STT_MODEL` | `scribe_v2` |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128`; desteklenen WAV isteğe bağlı |
| `DUB_DEFAULT_LANGUAGE` | `tr` |
| `DUB_MAX_CONCURRENCY` | `2` (1–8); sahne/segment işleri |
| `DUB_CACHE_TTL` | `86400` saniye (60–86400) |
| `DUB_CACHE_DIRECTORY` | `/tmp/videoquest-turkish-media` |
| `DUB_REQUEST_TIMEOUT_MS` | `120000` (1000–600000) |
| `DUB_MAX_RETRIES` | `3` (0–5) |
| `TRANSLATION_PROVIDER` | `openai` |
| `TRANSLATION_MODEL` | `gpt-4.1-mini`; structured JSON destekleyen model |
| `TRANSLATION_VERSION` | `scene-tr-v1`; çeviri davranışı değişince cache sürümünü değiştirin |
| `ELEVENLABS_PRONUNCIATION_DICTIONARY_ID` | İsteğe bağlı merkezi ElevenLabs dictionary locator |
| `ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID` | Dictionary seçilirse zorunlu version locator |

Tam container/video süresi için `ffprobe` erişilebilir olmalıdır; `/usr/bin/ffprobe` varsa otomatik kullanılır. Yoksa FFmpeg duration header'ı yalnız 0.01 saniye hassasiyetindedir. `ffmpeg-static` mevcut aktarım bağımlılığı olarak korunur.

### Troubleshooting / ElevenLabs errors

- `ELEVENLABS_NOT_CONFIGURED` / `OPENAI_NOT_CONFIGURED`: secret'ları backend servis ortamında tanımlayın; HTML veya tarayıcı depolamasına koymayın.
- `ELEVENLABS_MODEL_UNAVAILABLE` / dil desteği hatası: hesabın canlı `/v1/models` cevabını ve model erişimini kontrol edin. Başka modele sessiz geçiş yapılmaz.
- HTTP 401/403: API anahtarı, izin ve abonelik erişimini kontrol edin. 429: sınırlı retry sonrası kota/rate limit çözülünce UI'den retry kullanın.
- `DUB_REGENERATE_REQUIRED`: kaynak süreye anlamı koruyarak sığmayan konuşma; metni/sesi inceleyin, aşırı tempo veya kesme uygulanmaz.
- `DUB_MISSING_SEGMENTS`, `ALIGNMENT_*`, `TRANSLATION_*`: manifestteki segment kimlikleri ve hata satırlarıyla eksik çıktıyı inceleyin; eksik dublaj hazır sayılmaz.
- Sunucu restart sonrası `JOB_INTERRUPTED`: aynı diskte kalan cache ve upload ile retry yapılabilir. Ephemeral deployment disk'i kaybolduysa yeniden yüklemek gerekir.
- Final mix/alignment dinleme kalitesi, gerçek kaynakla ve ücretli sağlayıcı erişimiyle ayrıca doğrulanmalıdır; mock/FFmpeg testleri dil doğallığını ölçmez.

### Migration

Eski Gemini konuşma/çeviri/TTS uçları, Eleven v3 generator'ı ve tarayıcı segment scheduler/cache modülleri kaldırıldı. Production'da tek dublaj mimarisi vardır. Backup branch/tag ve bağımlılık envanteri: [Migration notes](docs/turkish-media-migration.md). Eski ses environment ayarları (`GEMINI_TRANSCRIBE_MODEL`, `GEMINI_DIALOGUE_MODEL`, `GEMINI_TTS_MODEL`, `KEEP_GEMINI_FILES`) artık kullanılmaz.

Kayıtlı oyunlar IndexedDB v2 ve `.vqgame` v2 ile kaynak videoyu, canonical manifesti ve gerçek final mix Blob'unu taşır. v1 içe aktarma kaynak videoyu/analizi korur; eski ses cache'i yeni oynatıcıda çalıştırılmaz. Yeni Türkçe ses için yeniden üretim gerekir; yeniden üretim mevcut source/translation cache'ini kullanır.

## Video URL desteği

Analiz şeması 6, sınıflandırma içeren aralıkları güven puanı yüksek olsa da bölüm başına tek bir görsel ikinci kontrolden geçirir. Kontrol sırasında desteklenmeyen sınıf adları, doğrulanmamış kayıtlar ve adayın kaynak zaman aralığını aşan sonuçlar kabul edilmez. Uzun aday listeleri JSON ortasından kesilmez. Genel yön ifadeleri, doğrulanmış daha ayrıntılı ana sınıfı tek başına geçersiz kılmaz; açık sınıf değişiklikleri ayrı kalır.

Mevcut kayıtlar korunur. Eski analizlerdeki görsel sınıflandırma tahminlerinin yeni kontrolden geçmesi için kaynak videonun yeniden analiz edilmesi gerekir. Rapor sürümü 3, kayıt başına doğrulama durumunu ve elenen adaylarla ilgili uyarıları taşır. Bu kontroller modelin görsel yorumunda hatasızlık garantisi vermez.

URL çözümleme HTML video/source öğelerini, iç içe iframe ve srcdoc oynatıcılarını, object/embed öğelerini, JSON-LD ve oynatıcı yapılandırmalarını tarar. Bulunan kaynaklar HTTP yanıtıyla doğrulanır. Genel tarama sonuç vermezse yt-dlp hem gömülü oynatıcı adreslerinde (VK dahil) hem asıl sayfada denenir; özgün referer ve imzalı sorgu parametreleri korunur.

MP4, WebM, MOV/M4V, OGV ve 3GP kaynakları ile HLS ve korumasız DASH akışları tanınır. HLS/DASH, uyumlu kodeklerle yeniden kodlama yapmadan MP4 olarak aktarılır; video ve ses birlikte korunur. Tarayıcının kodek desteği hâlâ geçerlidir. Özel/oturum gerektiren, DRM korumalı veya kaynak sunucunun engellediği videolar için evrensel erişim garantisi yoktur.

Tarama en çok 12 sayfa ve 4 gömülme seviyesiyle sınırlıdır. Genel tarama bütçesi 20 saniye, site çıkarıcı denemesi başına bütçe 20 saniye ve toplam çözümleme bütçesi 85 saniyedir. VK video adreslerinde genel tarama 12 saniye, çıkarıcı bütçesi 45 saniyedir; aynı videonun mobil ve canonical adresleri çıkarıcıya tekrar tekrar gönderilmez. `list` bilgisi yalnızca aynı VK videosunun bağlantıları arasında korunur. Aynı anda gelen aynı URL istekleri birleştirilir; önbellekteki kaynak yeniden doğrulanır.

Çıkarıcı süreçleri stdout/stderr sınırı, iptal ve süre aşımıyla yönetilir; eksik çalıştırılabilir dosya, süre aşımı ve kaynak HTTP 5xx hataları "video bulunamadı" olarak gösterilmez. İsteğe bağlı Python Chrome impersonation bağımlılığı zorunlu tutulmaz. Sunucu kayıtları imzalı URL veya çerez yerine hata sınıfı, HTTP durumları ve geçen süreyi içerir. `test/video-extractor.test.js` bu hata yollarını gerçek alt süreçlerle; `test/video-manifest.test.js` ise FFmpeg ve FFprobe mevcutsa gerçek DASH → MP4 aktarımında ses, görüntü ve çözünürlüğü denetler.

Canlı ortam teşhisi için `VIDEO_RESOLUTION_PROBE_URL` ve en fazla 15 dakika ileride bir epoch-milisaniye değeri olan `VIDEO_RESOLUTION_PROBE_UNTIL` birlikte ayarlanabilir. Başlangıçta bir kez, normal URL doğrulamasıyla çalışır; sunucunun açılmasını bekletmez. Teşhis sonrasında bu geçici ayarlar temizlenmelidir. Hata ayrıntılarında kaynak URL'leri ve kimlik bilgileri maskelenir; yeni bir HTTP erişim ucu açılmaz.

## Aktarım ve yeniden deneme sınırları

- Harici analiz yüklemesi: 250 MiB; geçici disk dosyasından iletilir ve işlem sonunda temizlenir.
- Yeni Türkçe medya için kaynak video yüklemesi: en çok 2 GiB, en çok 10 MiB chunk; sunucu kaynak container'ından kayıpsız ses çıkarır. Parça durumları diskten okunur ve tamamlanan parçalar tekrar gönderilmez. Kaynak video oynatımı yeniden kodlanmaz.
- Storyboard: en çok 20 dosya, her biri en çok 2 MiB.
- Tarayıcıya tam indirme: OPFS ve Web Locks destekleyen tarayıcılarda 2 GiB. Küçük ağ paketleri yaklaşık 1 MiB'lık sınırlı tamponda birleştirilerek yazılır; ekran ilerlemesi en sık 200 ms arayla güncellenir. Böylece her ağ paketi için ayrı disk yazması ve ekran güncellemesi beklenmez. İçerik uzunluğu bildirilmediğinde de sınır uygulanır. Boş alan ve aktarım bütünlüğü kontrol edilir. Destek yoksa bellekte indirme sınırı 600 MiB olarak korunur. İptal/hata ve kaynak değişiminde geçici dosyalar temizlenir; kapanmış sekmelerin geçici dosyaları sonraki indirmede temizlenir. Aktif sekmelerin videoları ve IndexedDB içindeki kayıtlı oyunlar silinmez. Kalıcı kayıt ek depolama alanı gerektirebilir. OPFS davranışı: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- URL arayüzünde “Bul ve indir” önce medya adresini sunucuda bulur. Dosyayı CORS kurallarına uygun, kimlik bilgisi göndermeyen HTTPS isteğiyle doğrudan indirmeyi dener; başlıklar 4 saniyede gelmezse veya doğrudan erişim/aktarım başarısızsa Render proxy yoluna döner. HLS/DASH doğrudan proxy üzerinden birleştirilir. Tam indirme sırasında ayrıca uzak önizleme veya oynatma kontrolü başlatılmaz. Yerel dosya tamamlanınca oynatıcı açılır ve analiz kullanılabilir olur; ses ve kareler aynı dosyadan hazırlanır. Sonraki analiz/dublaj servis istekleri devam eder.
- En az 8 MiB olan normal dosyalarda tek baytlık Range isteğiyle parça desteği kontrol edilir. Geçerli `Content-Range` ve güçlü ETag veya yeterince eski Last-Modified bulunursa 64 MiB altındaki dosyalarda en fazla 4 bağlantı ve 2 MiB parçalar; daha büyük dosyalarda en fazla 6 bağlantı ve 4 MiB parçalar kullanılır. Tüm grubun bitmesi beklenmez: sıradaki parça yazıcıya verilince boşalan yere yeni istek başlar, ağ ve disk işlemleri birlikte ilerler. Önden alınan parçalarda en fazla 24 MiB, yazıcıya verilen parçayla birlikte 28 MiB tutulur; dosya sırası korunur. Her parçanın boyutu, dosya toplamı ve sürümü doğrulanır; `If-Range` proxy üzerinden kaynağa da iletilir. Range yoksa gelen tam yanıt kullanılır; metadata eksikse normal indirme yapılır. Parça hatasında etkin istekler iptal edilir, eksik dosya temizlenir ve bir kez normal indirme denenir. 429 yanıtının Retry-After süresine uyulur; 30 saniyeyi aşan beklemeler hata olarak bildirilir. İptal, depolama ve boyut hataları tekrar indirme başlatmaz. HLS/DASH için paralel dosya aktarımı kullanılmaz. [HTTP Range davranışı](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests).

21 Eylül 2026 kontrollü karşılaştırma: bağlantı başına sınırlanmış yerel HTTP kaynağındaki aynı 96 MiB dosya eski 4 bağlantılı gruplarla 2112 ms, yeni 6 bağlantılı aktarımda 1280 ms sürdü (1,65 kat aktarım hızı). İstek sayısı 49'dan 25'e indi; SHA-256 aynı kaldı. Bu ölçüm gerçek kaynak sitenin, Render'ın veya telefon bağlantısının hız garantisi değildir.
- Her iki otomatik yol da başarısız olursa tarayıcıda video/kaynak sayfa açma ve indirilen dosyayı seçme düğmeleri gösterilir. Uygulama tarayıcının İndirilenler klasöründeki dosyayı kendiliğinden okuyamaz; kullanıcı dosyayı seçmelidir. Depolama/boyut sınırları korunur; kalite düşürülmez ve yeniden kodlama yapılmaz. Hız kaynak site ve bağlantıya bağlıdır. [Fetch davranışı](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch).
- Video proxy yanıt başlığı bekleme süresi: 30 saniye. Aktarım hareketsizliği: 45 saniye. HLS/DASH aktarım üst süresi: 30 dakika.
- Yeni provider istek süresi config ile yönetilir (varsayılan 120 saniye); job polling ve upload ayrı iptal/zaman aşımı yolları kullanır.

21 Eylül 2026 aktarım doğrulaması: 471 test geçti. Gerçek yerel HTTP sunucusunda bağlantı başına 64 KiB/8 ms sınırı altında 12 MiB dosya tek bağlantıyla 1.606 ms, paralel aktarımda 530 ms sürdü (yaklaşık 3 kat); SHA-256 özeti iki sonuçta da kaynakla eşleşti. Bu kontrollü ölçüm kullanıcının uzak kaynağının hızını kanıtlamaz. Gerçek telefonda aynı 65,9 MB kaynağın uçtan uca süresi ölçülmedi; kaynak toplam hızı sınırlarsa paralellik aynı kazancı sağlamaz. Testler ayrıca sürüm değişimi, bozuk/eksik parça, Range desteklemeyen kaynak, iptal, Retry-After, OPFS dosya temizliği ve otomatik proxy geçişini kapsar.

Tamamlanan analiz bölümleri aynı sekmede yeniden kullanılabilir. Okunamayan bölümler doğrulanmış içerik olarak gösterilmez. Görsel analiz oturumları ve uzak video bağlantı belirteçleri kalıcı veritabanında tutulmaz. Yeni Türkçe medya job/upload metadata’sı diskte 24 saat saklanır; aynı disk duruyorsa restart sonrası retry mümkündür.

## Dağıtım

Render yapılandırması: Node web service, build `npm ci`, start `npm start`; gerekli ortam değişkenlerini servis üzerinde tanımlayın. `/health`, oturum gerektirmeyen temel süreç kontrolüdür; ücretli analiz veya dublaj sağlayıcılarının sağlıklı olduğunu tek başına kanıtlamaz.

Yeni migration envanteri ve doğrulama sınırları: [Migration notes](docs/turkish-media-migration.md). Önceki sürümün tarihsel güvenilirlik raporu: [STABILITY_REPORT.md](STABILITY_REPORT.md).
