# Source Video Interactive App

Yerel dosya veya uzak video kaynağı üzerinde zaman damgalı analiz, etkileşimli video oynatma, Türkçe altyazı ve dublaj sunan Node.js/Express uygulaması.

## Çalıştırma ve doğrulama

Node.js 20.3 veya üzeri gerekir. Bu değişiklikler Node.js 24.19.0 üzerinde doğrulandı.

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

Hareket analizi Gemini storyboard uçlarını kullanır. Diyalog çözümlemesi ve çeviri ayrı Gemini işlemleridir. `/api/external-analyze` ayrıca yapılandırılmış harici servise dosya iletir; harici servisin kullanılabilirliği Gemini'den ayrı değerlendirilmelidir.

Gemini konuşma çözümleme, Türkçe çeviri ve satır duygusu için; ElevenLabs Eleven v3 ise doğal ve bağlama duyarlı oynatıcı dublaj seslerini üretmek için kullanılır. Dublaj modu bütün zamanlanmış Türkçe konuşma bloklarını oynatma başlamadan önce hazırlar.

Dublajdan önce tüm konuşmacılara `speakerId` bazında ayrı bir ElevenLabs sesi atanır. Türkçe uygunluğu ve ses profili dikkate alınır; aynı ses iki konuşmacıya verilmez. Atama yeniden denemelerde ve kayıtlı oyunlarda korunur. Hesapta yeterli uygun ses yoksa ya da atanmış ses kaldırılırsa açıklayıcı hata gösterilir; başka sese sessizce geçilmez. Ses listesi sayfalı okunur (en çok 1.000 katalog girdisi); video başına en çok 64 konuşmacı için atama yapılır. Kaynak konuşmacı ayrımındaki model hataları hâlâ doğruluğu etkileyebilir.

Kaynakta üst üste gelen farklı konuşmacılar bağımsız ses kanalları ve ayrı altyazı satırları kullanır. Bir karakterin cümlesi diğerinin başlangıcıyla kısaltılmaz; toplam ses seviyesi taşmayı önleyecek biçimde dengelenir. İleri/geri sarma, duraklatma ve eksik ses hazırlığı bütün aktif kanallara uygulanır. Eski kayıtların hazır sesleri korunur; eski iki sesli dublajı kişi bazlı seslere geçirmek için yeniden analiz/dublaj gerekir.

## Yapılandırma

| Değişken | Kullanım |
|---|---|
| `APP_PASSWORD` | Uygulamaya giriş parolası |
| `PORT` | HTTP dinleme portu |
| `EXTERNAL_ANALYSIS_URL` | Harici analiz servisinin kök adresi; kendi dağıtım adresinizle ayarlanmalıdır |
| `GEMINI_API_KEY` | Sunucu Gemini anahtarı; tarayıcı oturumundaki anahtar önceliklidir |
| `GEMINI_MODEL` | Storyboard model adı |
| `GEMINI_TRANSCRIBE_MODEL` | Diyalog çözümleme model adı |
| `GEMINI_DIALOGUE_MODEL` | Diyalog çeviri model adı |
| `GEMINI_TTS_MODEL` | Sunucudaki Gemini ses uçlarının model adı |
| `KEEP_GEMINI_FILES` | `true` ise yüklenen Gemini dosyalarının işlem sonunda silinmesini engeller |

Tarayıcıdan girilen sağlayıcı anahtarları oturum depolamasında tutulur. Depolamayı engelleyen bir tarayıcı uygulamayı açabilir, ancak bu anahtarları saklayamaz.

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
- Diyalog için video yüklemesi: 2 GiB; parça aktarımı kullanılır. Ses yüklemesi: toplam 250 MiB, tek parça en çok 10 MiB. 128 MiB üzerinde veya 15 dakikadan uzun video tarayıcıda bütünüyle çözülmez; sunucudaki geçici dosyadan analiz için MP3 hazırlanır. Oynatılan kaynak video yeniden kodlanmaz.
- Storyboard: en çok 20 dosya, her biri en çok 2 MiB.
- Tarayıcıya tam indirme: OPFS ve Web Locks destekleyen tarayıcılarda 2 GiB. Parçalar bekletilmeden cihaz depolamasına yazılır; içerik uzunluğu bildirilmediğinde de sınır uygulanır. Boş alan ve aktarım bütünlüğü kontrol edilir. Destek yoksa bellekte indirme sınırı 600 MiB olarak korunur. İptal/hata ve kaynak değişiminde geçici dosyalar temizlenir; kapanmış sekmelerin geçici dosyaları sonraki indirmede temizlenir. Aktif sekmelerin videoları ve IndexedDB içindeki kayıtlı oyunlar silinmez. Kalıcı kayıt ek depolama alanı gerektirebilir. OPFS davranışı: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- Video proxy yanıt başlığı bekleme süresi: 30 saniye. Aktarım hareketsizliği: 45 saniye. HLS/DASH aktarım üst süresi: 30 dakika.
- ElevenLabs sunucu istek süresi: 60 saniye. İstemci dublaj isteği: 70 saniye.

Tamamlanan analiz bölümleri aynı sekmede yeniden kullanılabilir. Okunamayan bölümler doğrulanmış içerik olarak gösterilmez. Analiz oturumları, video bağlantı belirteçleri ve yükleme oturumları kalıcı bir veritabanında tutulmaz; sayfa yenileme veya sunucu yeniden başlatma sonrasında devam garantisi yoktur.

## Dağıtım

Render yapılandırması: Node web service, build `npm ci`, start `npm start`; gerekli ortam değişkenlerini servis üzerinde tanımlayın. `/health`, oturum gerektirmeyen temel süreç kontrolüdür; ücretli analiz veya dublaj sağlayıcılarının sağlıklı olduğunu tek başına kanıtlamaz.

Ayrıntılı bulgular, uygulanan düzeltmeler ve doğrulama sınırları: [STABILITY_REPORT.md](STABILITY_REPORT.md).
