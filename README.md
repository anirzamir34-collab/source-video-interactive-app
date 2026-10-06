# Source Video Interactive App

Yerel dosya veya uzak video kaynağı üzerinde zaman damgalı analiz, etkileşimli video oynatma, Türkçe altyazı ve dublaj sunan Node.js/Express uygulaması.

## Çalıştırma ve doğrulama

Node.js 20.3 veya üzeri gerekir. Migration kontrolleri Node.js 24.19.0 ile çalıştırılır; güncel sonuçlar migration raporunda belirtilir.

```sh
npm ci
npm test
npm start
```

`npm ci`, tarayıcıda çalışan MP3 dönüştürücüsünü otomatik derler. Script çalıştırmadan kurulum yapılıyorsa önce `npm run build:audio` gerekir. Kaynak videonun sesi cihazda ayrılır ve 96 kbps / 32 kHz MP3 olarak gönderilir; ElevenLabs'a video veya kaynak WAV yüklenmez. Tam video süresi aktarım metadata'sında korunur ve aynı dosyanın hazır MP3'ü tekrar kullanılır.

Analiz göstergesi tek kompakt alanda o an yapılan işi, gerçek ilerlemeyi ve süreyi gösterir. MP3/görüntü aktarımı gerçek tarayıcı byte olaylarını; kare, çeviri, ses üretimi ve hizalama adımları tamamlanmış birim sayılarını kullanır. Sağlayıcının yüzde bildirmediği aşamalarda yanıt beklenir; tahmini toplam yüzde üretilmez. Tamamlanan aşamaların süreleri daha sonraki durum sorgularıyla uzamaz.

Son ses birleştirmede kaynak konuşma aralıkları sıralanıp birleştirilir ve dengeli bir zaman ağacında bulunur. Her stereo ses örneğinde bütün konuşmaları yeniden hesaplayan doğrusal filtre kaldırılmıştır; aynı yüzde 18 kaynak konuşma seviyesi, 40/80 ms geçişler, dublaj zamanları ve tek MP3 çıktısı korunur. `MIXING_AUDIO` ilerlemesi FFmpeg'in gerçekten kodladığı zaman çizelgesi saniyelerinden alınır. Yerel 120 saniye/24 aralık filtre karşılaştırması 43,315 saniyeden 2,599 saniyeye indi; bu ölçüm toplam analiz süresi veya canlı Render hızı için garanti değildir.

Gemini görsel analiz/doğrulama çağrılarında sağlayıcı HTTP beklemesi 90 saniyeyle sınırlıdır. SDK içinde ek retry yoktur; mevcut açık retry bütçesi en çok iki çağrıdır. Bu bütçe bittiğinde görseller daha küçük ücretli çağrılara bölünmez ve tarayıcı dört kez aynı beklemeyi tekrarlamaz. Analiz duraklar; aynı oturumda yeniden denendiğinde tamamlanmış bölümler ve doğrulama bekleyen ilk geçiş sonucu kullanılır. Bölümlerin sıralı hikâye bağlamı ve kritik bulguların kaynak doğrulaması korunur.

ElevenLabs ses üretiminden gelen karakter zamanları, kaynak cümle ve gerçek ses aralığıyla eksiksiz eşleşiyorsa yeniden kullanılır. Ses parçalarının birleştirilmesi ve ölçülen tempo değişimi bu zamanlara uygulanır; ek Forced Alignment çağrısı gerekmez. Eski cache'teki seslerin zamanları da orijinal üretim yanıtından geri alınır. Yalnız dublaj seçildiğinde kelime hizalama ve altyazı üretimi tamamen atlanır; yalnız altyazıda ses üretimi ve miks yoktur. Altyazı da seçiliyse eksik native zamanlar için doğrulanmış Forced Alignment yolu korunur. Hesap/izin hatası kalan kuyruğu hemen durdurur ve kısa Türkçe mesaj gösterilir. Geçici sorgu bağlantı hatasında mevcut iş tekrar kontrol edilir; yeni iş veya yeniden ses üretimi başlatılmaz.

Yerel MP3 kodlayıcısı [Mediabunny 1.61.1](https://github.com/Vanilagy/mediabunny/tree/v1.61.1) ve `@mediabunny/mp3-encoder` (MPL-2.0) ile [LAME 3.100](https://lame.sourceforge.io/) (LGPL) kullanır. Kaynak ve derleme talimatları Mediabunny deposunun `packages/mp3-encoder` bölümündedir; kodlayıcı değiştirilmeden paketlenir ve lisans bildirimleri derleme çıktısında korunur.

Başlatmadan önce `APP_PASSWORD` tanımlanmalıdır. Tanımlı değilse uygulama erişime açılmaz. `PORT` varsayılanı 10000'dir. Canlı ortamda HTTPS kullanılmalıdır; oturum çerezi `Secure` ve `HttpOnly` olarak oluşturulur.

`npm test`, sözdizimi denetimlerini, mevcut oynatıcı/analiz regresyonlarını, hata senaryolarını ve gerçek Express HTTP entegrasyonunu çalıştırır. HTTP testleri geçici bir yerel sunucu ve test parolası kullanır; ücretli model veya ses servislerine çağrı yapmaz. İlk migration commit'i `a3e2e95` için tam CI doğrulaması **744 pass, 0 fail, 0 skip** idi. Tarayıcı anahtarı/Gemini düzeltmesinin gerçek pipeline regresyonları **4 pass, 0 fail, 0 skip** verdi; sağlayıcı ağı ve ses işlemleri test doubles ile sınanır. Dosya/test/build/deploy raporu: [Implementation report](docs/turkish-media-implementation-report.md).

## Bileşenler

| Bileşen | İşlev |
|---|---|
| `server.js` | Oturum doğrulama, kaynak çözümleme ve aktarım, parça yükleme, analiz ve ses sağlayıcı uçları |
| `public/app.js` | Analiz yönetimi, video kaynağı yaşam döngüsü, altyazı ve dublaj senkronizasyonu |
| `public/storyboard.js` | Video örnekleme ve storyboard karelerinin hazırlanması |
| `public/analysis-recovery.js` | Analiz hatalarının sınıflandırılması ve yeniden deneme kuralları |
| `public/playback-logic.js`, `public/engine-hardening.js`, `public/story-engine.js` | Zaman çizelgesi, analiz doğrulama ve oynatma yardımcıları |

Hareket analizi Gemini storyboard uçlarını kullanır. `/api/external-analyze` ayrıca yapılandırılmış harici servise dosya iletir. Kaynak konuşma bilgisi görsel analize yalnızca özgün metin ve kaynak zamanlarıyla aktarılır; Türkçe ses veya hizalama zamanları etkileşimli seçimlerin kanıtı değildir. Seçim oynatımı kendi doğrulanmış kaynak aralığında biter. Yalnız görsel analiz istendiğinde kaynak konuşma servisi kullanılamazsa kare analizi boş konuşma bağlamıyla devam eder; dublaj/altyazı istendiyse hata açık kalır. Kullanıcı iptali her iki akışı durdurur.

## TURKISH DUBBING PIPELINE

```text
SOURCE VIDEO → FFmpeg extraction → Scribe v2 + diarization
→ canonical source transcript → contextual Gemini Turkish translation
→ stable speaker/voice mapping → Eleven v4 Text-to-Dialogue
→ real duration fitting → ElevenLabs Forced Alignment
→ source_tr + dub_tr (JSON/SRT/WebVTT) → normalized final mix → video player
```

Her aşama `lib/turkish-media/` altında ayrı modüldür. `segmentId` kaynak konuşmadan çeviri, ses, hizalama ve altyazıya kadar korunur. Scribe cevabındaki bütün kelime ve ses olayı verileri saklanır; gösterim metni özgün transcript'i değiştirmez. Konuşma atlanması, eksik API konuşma haritası veya eksik hizalama kelimesi işi `FAILED` yapar. Başarılı sonuçta QA raporunun `missingDubCount` değeri 0 olmalıdır.

Çeviri bütün sahne grubunu, önceki/sonraki konuşmaları ve her kaynak süreyi görür. Gemini `generateContent` yapılandırılmış JSON çevirisi kullanılır; OpenAI anahtarı veya çağrısı gerekmez. ASR ve ses üretimi ElevenLabs'ta kalır. Yalnız tahmini uzunluk nedeniyle bütün sahne yeniden çevrilmez. Aynı konuşmacının peş peşe gelen cümleleri, konuşmacı değişimi/örtüşme/ses olayı olmadan en çok 12 saniyelik konuşma aralığını paylaşabilir. Native zamanlar yalnız konuşma dışındaki boşluğu ve kelimeler arasında ölçülmüş uzun duraklamaları kısaltmak için kullanılır; duraklamalarda en az 140 ms korunur, ses yüksekliği eşiğiyle sessiz konuşma silinmez. Önce tercih edilen 1.20 tempo sınırı denenir; hâlâ sığmayan sesler ek çeviri/üretim çağrısı olmadan ölçülmüş süreye uyarlanır: 1.20 katı aşmak bütün videoyu durdurmaz. Büyük tempo oranları, örnek atlayan tek filtre yerine her biri en çok 2 olan atempo zinciriyle uygulanır. `maxDubTempo` ve `adaptiveTempoCount` QA'da kaydedilir; büyük oranlar daha hızlı konuşma demektir ve doğal söyleyişi azaltabilir. Söylenen kelimeler kesilmez; kelime zamanları kesilen boşluk ve uygulanan tempo ile birlikte dönüştürülür. Kaynak Scribe saatleri, kaynak altyazı ve orijinal dilin susturma aralıkları değişmez. Başka konuşmacı/ses olayına taşmadan en çok bir saniyelik kaynak sessizliği kullanılabilir. Uzun diyaloglar API'nin canlı karakter sınırına göre bölünüp aynı kaynak segmenti altında birleştirilir. Kaynakta örtüşen konuşmalar bağımsız kalır.

Üretilen ses bir kez PCM'e çözülür; konuşma bölme, süre ölçme ve sessizlikle doldurma örnek sayılarıyla doğrudan yapılır. Her konuşma için bütün MP3 yeniden çözülmez ve tekrar tekrar FFmpeg/ffprobe başlatılmaz. Son karışımda konuşmalar örnek saatleriyle tek dublaj kanalında toplanır; 192 kHz yeniden örneklemeye ihtiyaç duymayan tek geçişli kompresör ve iki kanallı karışım kullanılır. Son oynatma/kayıt çıktısı 128 kbps stereo MP3'tür; geçici PCM dosyaları kullanıcıya sunulmaz. Kaynak ses konuşma/dublaj aralıklarında yumuşak geçişle %18 seviyesine kısılır; diğer boşluklarda kaynak ses korunur. İşlem belleği sabit boyutlu kopyalama tamponlarıyla sınırlıdır.

Tempo filtresinin kısa seslerde bıraktığı analiz penceresi farkı, metnin fazla uzun olduğu anlamına gelmez. Hedef aralık 48 kHz örnek sayısına yuvarlanır; çıktı örnekleri hedefi geçerse ölçülmüş fark ve küçük, büyüyen bir payla tempo yeniden hesaplanır. Neredeyse aynı tempo ile aynı pencere tekrar tekrar denenmez. İşlenen bütün ses korunur, yalnız eksik son kısma sessizlik eklenir. Regresyon kontrolü canlıda başarısız olan 0.72/0.88 saniyelik ses → 0.64 saniye aralığını farklı dalga biçimleriyle kapsar.

Kelime zamanları yeni ve cache'deki dublajlarda aynı video aralığıyla doğrulanır. PCM ile video saati arasında yalnız bir örneğe kadar yuvarlama farkı sınırda düzeltilir; kaynak konuşma zamanları ve bütün kelimeler korunur. Gerçek süre taşmaları, geriye giden ve geçersiz kelime aralıkları kabul edilmez; hata kaydına metin eklemeden konuşma kimliği, kelime indeksi ve sayısal sınırlar yazılır. 79 konuşmalık regresyon altyazı, son karışım ve önceki cache zamanlarının yeniden kullanımını; gerçek FFmpeg kontrolü PCM → kelime → altyazı → son karışımı kapsar.

**Model seçimi:** varsayılan `quality` modu `eleven_v4`, transcription `scribe_v2` kullanır. Canlı ElevenLabs model listesinde model ve Türkçe (`tr`) desteği doğrulanmadan sentez gönderilmez. `fast` için `eleven_v4_turbo` ayrılmıştır; erişilebilir resmî kaynaklar yeni Text-to-Dialogue WebSocket URL/protokolünü açıklamadığı için bu mod şimdilik kapalıdır ve `FAST_MODEL_PROTOCOL_UNVERIFIED` döndürür. Eski model veya sağlayıcıya fallback yoktur. Doğrulanan sözleşmeler: [API contract](docs/turkish-media-api-contract.md).

Konuşmacı kimliği video boyunca sabittir; her konuşmacı farklı bir sese eşlenir ve eşleme manifest/kayıt içinde saklanır. Scribe ses cinsiyetini bildirmez: belirsiz kimlikler için otomatik atama aynı sesi korur fakat doğru kadın/erkek eşleşmesini kanıtlamaz. Konuşmacı sesleri arayüzden seçilebilir ve aynı kaynak cache'i kullanılarak yeniden üretilebilir. Voice ID'leri gizli anahtar değildir ve katalogdan sağlanır.

**Anahtar kullanımı:** “ELEVENLABS DOĞAL DUBLAJ” alanına anahtarı yazmak yeterlidir; ayrı “Kullan” işlemi zorunlu değildir. Bu anahtar yalnız parola alanı/geçici bellekte tutulur ve ilgili medya isteklerinde backend'e gönderilir; localStorage/sessionStorage, kayıt, export veya log'a yazılmaz. İstek anahtarı sunucunun `ELEVENLABS_API_KEY` değerine önceliklidir. Gemini kullanıcı anahtarı isteğe bağlıdır ve mevcut session davranışı korunur; yoksa sunucudaki `GEMINI_API_KEY` çeviride kullanılır. Böylece tarayıcı ElevenLabs anahtarı + sunucu Gemini anahtarı yeterlidir. Sağlayıcı çağrıları backend'den yapılır; anahtarlar job JSON'una veya manifestine girmez.

**Altyazılar:** `source_tr`, Türkçe metni özgün konuşma aralığında gösterir; Türkçe kelimelere tahmini zaman uydurmaz. `dub_tr`, üretilmiş ve süreye uydurulmuş gerçek Türkçe ses üzerindeki Forced Alignment zamanlarını kullanır. Dublaj açıkken varsayılan `dub_tr` olur. İki kanal UTF-8 SRT/WebVTT ve internal JSON olarak üretilir. Seek/pause/replay/fullscreen tek altyazı görünümünü video saatinden günceller. Kaynakta eşzamanlı konuşan kişiler ayrı satırlarda gösterilebilir.

**Oynatma:** Türkçe ses başarıyla başlayınca kaynak video susturulur. Oynatma veya dosya açma hatasında kaynak ses geri gelir. Kaydetmek için indirilen MP3, aynı oynatıcıda yerel blob üzerinden kullanılır. Altyazı seçilmemişse SRT/VTT indirme bağlantıları gösterilmez. Dosya bütünlüğü ilk erişimde doğrulanır; değişmeyen dosyalarda sonraki Range istekleri tekrar tam dosya hash'i hesaplamaz, dosya stat bilgisi değişirse doğrulama yenilenir.

**Miks:** merkezi FFmpeg servisi kaynak sesini stereo 48 kHz WAV olarak korur, Türkçe sesleri kaynak zamanlarına yerleştirir ve clipping'i sınırlar. Audio helper hazır ayrılmış background track destekler; mevcut ürün pipeline'ı harici background kabul etmez. Varsayılan `speech-ducking` konuşma/dublaj aralıklarında kaynak sesini %18 seviyesinde korur. Müzik ve efektler de bu aralıklarda birlikte kısılır; diğer sahnelerde normal kaynak seviyesi korunur. Bu yöntem gerçek konuşma/müzik ayrıştırması değildir; QA raporunda miks yöntemi görünür. PCM isteği, kanal sayısı tahmin edilmeden aynı sample rate'te belgelenmiş headerlı WAV isteğine dönüştürülür. Hesap formatı açıkça reddederse aynı modelde MP3 kullanılır.

**Cache ve işler:** 24 saatlik disk cache; ayrılmış ses SHA-256, model, metin, voice mapping, çeviri sürümü, format, ilgili ayarlar ve kullanılan sağlayıcı anahtarlarının SHA-256 kapsamı ile anahtarlanır; ham anahtar saklanmaz. Farklı veya hatalı anahtarla yeni iş eski hesabın hazır miksini cache'ten açmaz. Hazır aşamalar ve segmentler hemen kaydedilir; retry tamamlanan ücretli aşamaları yeniden çağırmaz. Restart sonrası retry aynı sağlayıcı anahtarlarını yeniden ister; farklı anahtarlarla yeni iş başlatılır. Aynı kaynak dosya chunk yüklemesi restart sonrası sürdürülebilir; URL video cache'i aynı videonun yeniden indirilmesini önler. Aktif dosyalar lease ile temizlemeden korunur; işler tek video sırasından, sahneler sınırlı eşzamanlılıkla yürür. Disk farklı sunucular arasında paylaşılmaz; yerel cache process lease'leri dağıtık değildir. Mevcut kaynak URL resolver/deployment değiştirilmedi.

Frontend `PREPARING_AUDIO`, `TRANSCRIBING`, `DIARIZING`, `TRANSLATING`, `GENERATING_DUB`, `ALIGNING`, `BUILDING_SUBTITLES`, `MIXING_AUDIO`, `READY`, `FAILED` durumlarını gösterir; iptal ve retry vardır. 429/5xx/network/timeout kontrollü backoff + jitter ile tekrar edilir. Sağlayıcının doğrulanmış idempotency desteği olmadığı için yanıtı kaybolan bir ücretli HTTP isteğinin yeniden ücretlendirilmesini kesin olarak önleme garantisi yoktur; tamamlanan aşama cache'i ve single-flight gereksiz tekrarları azaltır.

Medya aşamaları `media_stage_start` / `media_stage_end` JSON logları üretir. `timestamp`, `startedAt` ve `endedAt` UTC'dir; `durationMs`, `jobId`, `operationId` ve ilgili konuşmada `segmentId` bulunur. Sonuç `completed`, `cache_hit`, `shared_result`, `skipped`, `failed` veya `cancelled` olarak görünür; cache kapsamı ve atlama nedeni ayrıca kaydedilebilir. Hataların mesaj/stack/cause alanları maskelenir; API anahtarları, kaynak konuşma metni ve özel dosya yolları log metadata'sına taşınmaz.

### Yapılandırma

| Değişken | Varsayılan / kullanım |
|---|---|
| `APP_PASSWORD` | Zorunlu uygulama giriş parolası |
| `PORT` | `10000` |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Görsel analiz ve Türkçe çeviri için sunucu fallback'i; kullanıcı Gemini anahtarı önceliklidir. Model varsayılanı `gemini-3.8-flash` |
| `EXTERNAL_ANALYSIS_URL` | İsteğe bağlı harici analiz servisi |
| `ELEVENLABS_API_KEY` | Transcription/dublaj/hizalama/katalog için isteğe bağlı sunucu fallback'i; tarayıcı anahtarıyla zorunlu değildir |
| `DUB_QUALITY_MODE` | `quality`; `fast` sözleşme doğrulanana kadar kapalı |
| `ELEVENLABS_DUB_MODEL` | `eleven_v4` |
| `ELEVENLABS_FAST_MODEL` | `eleven_v4_turbo` |
| `ELEVENLABS_STT_MODEL` | `scribe_v2` |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128`; desteklenen WAV isteğe bağlı |
| `DUB_DEFAULT_LANGUAGE` | `tr` |
| `DUB_MAX_CONCURRENCY` | `2` (1–8); sahne/segment işleri |
| `DUB_CACHE_TTL` | `86400` saniye (60–86400) |
| `DUB_CACHE_DIRECTORY` | `/tmp/videoquest-turkish-media` |
| `DUB_REQUEST_TIMEOUT_MS` | `300000` (1000–600000) |
| `DUB_MAX_RETRIES` | `3` (0–5) |
| `TRANSLATION_PROVIDER` | `gemini`; bu sürüm yalnız Gemini kabul eder |
| `TRANSLATION_MODEL` | Öncelik: bu değer → `GEMINI_MODEL` → `gemini-3.8-flash`; JSON schema destekleyen erişilebilir model |
| `TRANSLATION_VERSION` | `scene-tr-gemini-v2`; çeviri davranışı değişince cache sürümünü değiştirin |
| `ELEVENLABS_PRONUNCIATION_DICTIONARY_ID` | İsteğe bağlı merkezi ElevenLabs dictionary locator |
| `ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID` | Dictionary seçilirse zorunlu version locator |

Tam container/video süresi için `ffprobe` erişilebilir olmalıdır; `/usr/bin/ffprobe` varsa otomatik kullanılır. Yoksa FFmpeg duration header'ı yalnız 0.01 saniye hassasiyetindedir. `ffmpeg-static` mevcut aktarım bağımlılığı olarak korunur.

### Troubleshooting / ElevenLabs errors

- `ELEVENLABS_NOT_CONFIGURED`: ElevenLabs anahtarını arayüzde yazın veya sunucuda `ELEVENLABS_API_KEY` tanımlayın. `GEMINI_NOT_CONFIGURED`: isteğe bağlı kullanıcı Gemini anahtarını girin veya sunucuda `GEMINI_API_KEY` tanımlayın. OpenAI ayarı gerekmez.
- `MEDIA_CREDENTIAL_SCOPE_MISMATCH`: retry için önceki işte kullanılan anahtarları yeniden sağlayın; yeni anahtarla yeni iş başlatın.
- `ELEVENLABS_MODEL_UNAVAILABLE` / dil desteği hatası: hesabın canlı `/v1/models` cevabını ve model erişimini kontrol edin. Başka modele sessiz geçiş yapılmaz.
- HTTP 401/403: API anahtarı, izin ve abonelik erişimini kontrol edin. 429: sınırlı retry sonrası kota/rate limit çözülünce UI'den retry kullanın.
- `DUB_REGENERATE_REQUIRED`: kaynak süreye anlamı koruyarak sığmayan konuşma; metni/sesi inceleyin, aşırı tempo veya kesme uygulanmaz.
- `DUB_MISSING_SEGMENTS`, `ALIGNMENT_*`, `TRANSLATION_*`: manifestteki segment kimlikleri ve hata satırlarıyla eksik çıktıyı inceleyin; eksik dublaj hazır sayılmaz.
- Sunucu restart sonrası `JOB_INTERRUPTED`: aynı diskte kalan cache ve upload ile retry yapılabilir. Ephemeral deployment disk'i kaybolduysa yeniden yüklemek gerekir.
- Final mix/alignment dinleme kalitesi, gerçek kaynakla ve ücretli sağlayıcı erişimiyle ayrıca doğrulanmalıdır; mock/FFmpeg testleri dil doğallığını ölçmez.

### Migration

Eski Gemini konuşma/çeviri/TTS uçları, Eleven v3 generator'ı ve tarayıcı segment scheduler/cache modülleri kaldırıldı. Yeni Gemini çeviri adapter'ı canonical transcript'i kullanır; eski motoru geri açmaz. İlk migration'ın OpenAI çeviri seçimi 2 Ekim 2026 tarayıcı anahtarı düzeltmesinde Gemini ile değiştirildi. Production'da tek dublaj mimarisi vardır. Backup branch/tag ve bağımlılık envanteri: [Migration notes](docs/turkish-media-migration.md). Eski ses environment ayarları (`GEMINI_TRANSCRIBE_MODEL`, `GEMINI_DIALOGUE_MODEL`, `GEMINI_TTS_MODEL`, `KEEP_GEMINI_FILES`) artık kullanılmaz.

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
- Türkçe medya için video cihazda kalır; yalnız ayrılmış ses yüklenir (en çok 250 MiB, en çok 10 MiB chunk). Standart MP4/AAC ses kanalı eski Blob-slice remux yolu ile kayıpsız ayrılır; sıkıştırılmış paketler ve edit listeleri korunur. Küçük desteklenen diğer dosyalar cihazda Web Audio ile ses WAV'ına dönüştürülür. Cihazda ses ayrılamazsa açık hata verilir; kaynak video sunucuya yüklenmez. Ayrılan ses aynı Blob için tekrar kullanılır; tamamlanan yükleme parçaları tekrar gönderilmez. Eleven v4 dublajı, Scribe v2 ve hizalanmış altyazı akışı sürer.
- Storyboard: en çok 20 dosya, her biri en çok 2 MiB.
- Tarayıcıya tam indirme: OPFS ve Web Locks destekleyen tarayıcılarda 2 GiB. Küçük ağ paketleri yaklaşık 1 MiB'lık sınırlı tamponda birleştirilerek yazılır; ekran ilerlemesi en sık 200 ms arayla güncellenir. Böylece her ağ paketi için ayrı disk yazması ve ekran güncellemesi beklenmez. İçerik uzunluğu bildirilmediğinde de sınır uygulanır. Boş alan ve aktarım bütünlüğü kontrol edilir. Destek yoksa bellekte indirme sınırı 600 MiB olarak korunur. İptal/hata ve kaynak değişiminde geçici dosyalar temizlenir; kapanmış sekmelerin geçici dosyaları sonraki indirmede temizlenir. Aktif sekmelerin videoları ve IndexedDB içindeki kayıtlı oyunlar silinmez. Kalıcı kayıt ek depolama alanı gerektirebilir. OPFS davranışı: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- URL arayüzünde “Bul ve indir” önce medya adresini sunucuda bulur. Dosyayı CORS kurallarına uygun, kimlik bilgisi göndermeyen HTTPS isteğiyle doğrudan indirmeyi dener; başlıklar 4 saniyede gelmezse veya doğrudan erişim/aktarım başarısızsa Render proxy yoluna döner. HLS/DASH doğrudan proxy üzerinden birleştirilir. Tam indirme sırasında ayrıca uzak önizleme veya oynatma kontrolü başlatılmaz. Yerel dosya tamamlanınca oynatıcı açılır ve analiz kullanılabilir olur; ses ve kareler aynı dosyadan hazırlanır. Sonraki analiz/dublaj servis istekleri devam eder.
- En az 8 MiB olan normal dosyalarda tek baytlık Range isteğiyle parça desteği kontrol edilir. Geçerli `Content-Range` ve güçlü ETag veya yeterince eski Last-Modified bulunursa 64 MiB altındaki dosyalarda en fazla 4 bağlantı ve 2 MiB parçalar; daha büyük dosyalarda en fazla 6 bağlantı ve 4 MiB parçalar kullanılır. Tüm grubun bitmesi beklenmez: sıradaki parça yazıcıya verilince boşalan yere yeni istek başlar, ağ ve disk işlemleri birlikte ilerler. Önden alınan parçalarda en fazla 24 MiB, yazıcıya verilen parçayla birlikte 28 MiB tutulur; dosya sırası korunur. Her parçanın boyutu, dosya toplamı ve sürümü doğrulanır; `If-Range` proxy üzerinden kaynağa da iletilir. Range yoksa gelen tam yanıt kullanılır; metadata eksikse normal indirme yapılır. Parça hatasında etkin istekler iptal edilir, eksik dosya temizlenir ve bir kez normal indirme denenir. 429 yanıtının Retry-After süresine uyulur; 30 saniyeyi aşan beklemeler hata olarak bildirilir. İptal, depolama ve boyut hataları tekrar indirme başlatmaz. HLS/DASH için paralel dosya aktarımı kullanılmaz. [HTTP Range davranışı](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests).

21 Eylül 2026 kontrollü karşılaştırma: bağlantı başına sınırlanmış yerel HTTP kaynağındaki aynı 96 MiB dosya eski 4 bağlantılı gruplarla 2112 ms, yeni 6 bağlantılı aktarımda 1280 ms sürdü (1,65 kat aktarım hızı). İstek sayısı 49'dan 25'e indi; SHA-256 aynı kaldı. Bu ölçüm gerçek kaynak sitenin, Render'ın veya telefon bağlantısının hız garantisi değildir.
- Her iki otomatik yol da başarısız olursa tarayıcıda video/kaynak sayfa açma ve indirilen dosyayı seçme düğmeleri gösterilir. Uygulama tarayıcının İndirilenler klasöründeki dosyayı kendiliğinden okuyamaz; kullanıcı dosyayı seçmelidir. Depolama/boyut sınırları korunur; kalite düşürülmez ve yeniden kodlama yapılmaz. Hız kaynak site ve bağlantıya bağlıdır. [Fetch davranışı](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch).
- Video proxy yanıt başlığı bekleme süresi: 30 saniye. Aktarım hareketsizliği: 45 saniye. HLS/DASH aktarım üst süresi: 30 dakika.
- Yeni provider istek süresi config ile yönetilir (varsayılan 300 saniye); job polling ve upload ayrı iptal/zaman aşımı yolları kullanır.

21 Eylül 2026 aktarım doğrulaması: 471 test geçti. Gerçek yerel HTTP sunucusunda bağlantı başına 64 KiB/8 ms sınırı altında 12 MiB dosya tek bağlantıyla 1.606 ms, paralel aktarımda 530 ms sürdü (yaklaşık 3 kat); SHA-256 özeti iki sonuçta da kaynakla eşleşti. Bu kontrollü ölçüm kullanıcının uzak kaynağının hızını kanıtlamaz. Gerçek telefonda aynı 65,9 MB kaynağın uçtan uca süresi ölçülmedi; kaynak toplam hızı sınırlarsa paralellik aynı kazancı sağlamaz. Testler ayrıca sürüm değişimi, bozuk/eksik parça, Range desteklemeyen kaynak, iptal, Retry-After, OPFS dosya temizliği ve otomatik proxy geçişini kapsar.

Tamamlanan analiz bölümleri aynı sekmede yeniden kullanılabilir. Okunamayan bölümler doğrulanmış içerik olarak gösterilmez. Görsel analiz oturumları ve uzak video bağlantı belirteçleri kalıcı veritabanında tutulmaz. Yeni Türkçe medya job/upload metadata’sı diskte 24 saat saklanır; aynı disk duruyorsa restart sonrası retry mümkündür.

## Dağıtım

Render yapılandırması: Node web service, build `npm ci`, start `npm start`; gerekli ortam değişkenlerini servis üzerinde tanımlayın. `/health`, oturum gerektirmeyen temel süreç kontrolüdür; ücretli analiz veya dublaj sağlayıcılarının sağlıklı olduğunu tek başına kanıtlamaz.

Dağıtım doğrulamasında `/health` cevabındaki `deploymentCommit`, hedef Git SHA ile aynı olmalıdır; değer Render'ın `RENDER_GIT_COMMIT` ortamından gelir. Yanıt `no-store` kullanır ve Türkçe medya `qualityMode`, `pipelineVersion`, `scribe_v2` / `eleven_v4` model ayarlarını bildirir. Bunlar çalışan sürümü ve yapılandırmayı gösterir; gerçek sağlayıcı/model erişimi kanıtı değildir. Başlangıçtaki salt okunur runtime/route tanılamaları ayrı loglanır ve sunucunun dinlemeye başlamasını bekletmez.

Yeni migration envanteri ve doğrulama sınırları: [Migration notes](docs/turkish-media-migration.md). Önceki sürümün tarihsel güvenilirlik raporu: [STABILITY_REPORT.md](STABILITY_REPORT.md).

Çıktılar seçimden bağımsız açılmaz: dublaj düğmesi altyazıyı değiştirmez, yalnız dublajda altyazı kanalı gösterilmez. Manuel ses/yazı zaman kaydırma arayüzü kaldırılmıştır. Sığmayan sesler tekrar çeviri/ses üretimi yerine kaynak sessizlikleri ve yerel pitch-korumalı tempo işlemiyle düzenlenir; çok yüksek tempo doğal konuşmayı hızlandırabilir, kalite raporunda tempo yer alır. Kaynak konuşma kesimlerinde ve Türkçe ses uçlarında 5 ms geçişler ani dalga sıçramalarını azaltır; eski kayıtlı PCM sesler bir kez yerel olarak yumuşatılır.

Genel seçimli oynatımda hareket bitişi devam eden konuşmayı kesmez: kaynak konuşma ve açık dublajın gerçek bitişleri, 120 ms nefes payıyla karar sınırını geciktirir. Video ileri sarılmaz; aynı timeupdate dinleyicisi konuşma bitene kadar oynatır.

Eski `originalSpeechMuted` kayıtlarında, susturulmuş kaynak konuşma kayıtlı videonun kendi sesinden kısık seviyede geri getirilir. Dublaj ses yüksekliği korunur; diğer aralıklarda mevcut miks kaynak sesi taşır. Bu uyumluluk yolu yereldir, yeni sağlayıcı isteği oluşturmaz.
