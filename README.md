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

Mevcut istemci dublajı ElevenLabs kullanır. Azure/Gemini ses uçlarının sunucuda bulunması, oynatıcının bunlara otomatik geçeceği anlamına gelmez. Arayüz dublaj için gereken ElevenLabs anahtarını açıkça belirtir.

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

## Aktarım ve yeniden deneme sınırları

- Harici analiz yüklemesi: 250 MiB; geçici disk dosyasından iletilir ve işlem sonunda temizlenir.
- Diyalog dosyası yüklemesi: 600 MiB. Parçalı ses yüklemesi: toplam 250 MiB, tek parça en çok 10 MiB.
- Storyboard: en çok 20 dosya, her biri en çok 2 MiB.
- Tarayıcıya tam indirme: en çok 600 MiB; içerik uzunluğu bildirilmediğinde de sınır uygulanır.
- Video proxy yanıt başlığı bekleme süresi: 30 saniye. Aktarım hareketsizliği: 45 saniye. HLS dönüşüm üst süresi: 30 dakika.
- Azure/ElevenLabs sunucu istek süresi: 60 saniye. İstemci dublaj isteği: 70 saniye.

Tamamlanan analiz bölümleri aynı sekmede yeniden kullanılabilir. Okunamayan bölümler doğrulanmış içerik olarak gösterilmez. Analiz oturumları, video bağlantı belirteçleri ve yükleme oturumları kalıcı bir veritabanında tutulmaz; sayfa yenileme veya sunucu yeniden başlatma sonrasında devam garantisi yoktur.

## Dağıtım

Render yapılandırması: Node web service, build `npm ci`, start `npm start`; gerekli ortam değişkenlerini servis üzerinde tanımlayın. `/health`, oturum gerektirmeyen temel süreç kontrolüdür; ücretli analiz veya dublaj sağlayıcılarının sağlıklı olduğunu tek başına kanıtlamaz.

Ayrıntılı bulgular, uygulanan düzeltmeler ve doğrulama sınırları: [STABILITY_REPORT.md](STABILITY_REPORT.md).
