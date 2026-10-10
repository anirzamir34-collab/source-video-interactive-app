# VideoQuest — güncel sürümle genel altyapı düzeltmeleri

## Başlangıç ve önceki çalışmanın durumu

10 Ekim 2026 tarihinde GitHub main ve Render canlı sürümü aynı commit olarak doğrulandı:
`5afc358a688d958c4a540b068b447d1f15e35060`.
Render başlangıç yayını: `dep-db4l7pe8bjmc73aau21g`.

Önceki oturumun yerel kaydı `d50c8e69df1f890594f0433ad5f24d264a0ea1e0`,
`4f76fc8` tabanlı 23 dosyalık bir commit. Önceki 1.013 test sonucu o kayda aittir.
Bu kayıt GitHub'a gönderilememiş; değişiklikler kaybolmamış, eski çalışma ağacında korunuyor.
Kullanıcının belirttiği beş dosya ile yerel commit'in toplam dosya sayısı aynı değil.
Eski commit bütünüyle güncel kodun üzerine uygulanmadı.

- `920684a`: ses perdesinin ilk güvenilir yerel minimumla hesaplanması, Gemini JSON karakter bağlamı ve ilgili nihai ses önbelleği güncellemesi zaten yayınlanmış.
- `e926c9b`: normal seçimlerin başlangıç zamanı, yalnızca söylenen eyleme ilişkin yönlendirme kontrolü ve kaynak aralıklarına dayalı genel ilerleme düzeltmeleri zaten yayınlanmış.
- `eb5acfd` ve `2e87bae`: güncel arayüz değişiklikleri korundu.
- `5afc358`: birebir kaynak kopyası temizliği korundu, farklı anlamdaki kayıtları kaybetmemesi için kimlik anahtarı genişletildi.
- Eski yamadaki belirsiz konuşmacıda dublajı durduran kontroller, tempo için yeni engelleyici eşik ve diğer dublaj mimarisi değişiklikleri taşınmadı. Güncel çalışan dublaj akışına müdahale edilmedi.

## Yeniden üretilen nedenler ve yapılan değişiklikler

| Alan / dosya | Kök neden | Düzeltme |
| --- | --- | --- |
| `public/choice-routing.js` | Üst sahnenin panel/sonuç metadatası, kaynağı doğrulanmış normal diyalog türünden önce değerlendiriliyordu. | Normal hikâye türleri önce değerlendirilir; doğrulanmamış kaynaklar hâlâ kabul edilmez. Diyalog kendi gerçek zaman aralığında kalır. |
| `public/choice-groups.js` | Kopya anahtarı aynı ID/zaman/grup değerlerinin aynı olayı temsil ettiğini varsayıyor, farklı karakter veya yönlendirmedeki kaydı silebiliyordu. | Kategori, rota, karakter rolleri, katılımcılar, eylem türü ve kaynak kökeni de karşılaştırılır. Birebir kopyalar silinir; farklı olaylar ve sonraki ayrı zaman aralıkları korunur. |
| `public/character-identity.js` | Kimlik normalizasyonu primaryCharacterId ve involvedCharacterIds alanlarını kapsamıyordu; çatışmalı kayıtlar alias kanıtı olabiliyordu. | Bağlama öncesinde bütün ilgili alanlar ortak kayda dönüştürülür; çatışmalı eşlemeler kimlikleri zorla birleştirmez. |
| `public/playback-logic.js` | Ayrı seek çağrıları arasında video başına ortak sahiplik yoktu. play() tamponlama sırasında süresiz bekleyebiliyordu. | Yeni seek eskisini ve bekleyen play işlemini iptal eder. Normal play 12 saniye ile sınırlıdır; gerçek oynatma/hazırlık durumu beklenir, dinleyiciler temizlenir. |
| `public/app.js` | Normal devam yolları sınırsız play() beklemesini kullanıyordu. İptal edilen eski çağrının kurtarma arayüzü yeni seçimi etkileyebilirdi. | Üç genel devam yolu sınırlı oynatma yardımcısını kullanır; AbortError eski işlemin arayüze dönmesini engeller. Yeni main'deki senkronize normal diyalog başlangıç mantığı korunur. |

Bu oynatma riskleri kod ve kontrollü medya olaylarıyla doğrulandı. Kullanıcının videosundaki donmanın tek nedeninin bunlar olduğu kanıtlanmış değildir.

## Doğrulama sonuçları

- `npm run build:audio`: başarılı.
- `npm test`: **1.015 geçti, 0 başarısız, 0 atlanan**. Üretim JavaScript sözdizimi kontrolü dahil.
- Odaklı kimlik, kaynak gruplama, genel yönlendirme ve oynatma paketi: **87 geçti**.
- `git diff --check`: başarılı.
- Yerel gerçek sunucuda `/health`, parola ile oturum açma, `/` ve değişen istemci modülleri: HTTP 200; oturumsuz API çağrısı: beklenen HTTP 401.
- Gerçek PCM/FFmpeg çıkarma, konuşma aralığı ayırma, birleştirme ve süre uyarlama regresyonları tam pakette geçti. Bunlar gerçek kadın/erkek konuşmasını dinleyerek değerlendirme yerine geçmez.
- Normal diyalogda yetişkin içerikli bir cümle ve eski üst sahne metadatası birlikte verildiğinde yönlendirme normal hikâyede kaldı; doğrulanmamış kaynak reddedildi.
- Üç genel kaynak seçeneğinin altı farklı sırası test edildi. Tam aralığı izleme koşulu olmadan geçerli seçimler 100'e ulaştı, sonraki bölüm açıldı, aradaki kaynak boşluğu bütçeye eklenmedi. Tekrar seçim ek puan vermedi; başarısız oynatma ilerletmedi; yeni kaynak sahnesine geçiş ilerlemeyi sıfırladı.
- Bu ilerleme sonucu güncel main'deki mekanizmayı doğrular; bu değişiklikte yeni bir ilerleme algoritması yazılmadı.

Eklenen/güncellenen testler: `test/general-integrity.test.js`, `test/character-identity.test.js`,
`test/playback-logic.test.js`, `test/player-navigation.test.js`.

## Eksik doğrulamalar ve kapsam dışında kalanlar

İki ekran görüntüsü ve JSON raporu mevcut; orijinal kaynak video ve kaynak/dublaj ses dosyaları mevcut değil.
Bu nedenle gerçek konuşmacı eşleşmesinin bütün video boyunca işitsel A/B kontrolü, örnek videoda yeni Gemini/ElevenLabs uçtan uca üretimi ve gerçek görüntüde sahne sınırı ölçümü yapılmadı.

Gerçek tarayıcı tam ekran/mobil oynatma doğrulaması tamamlanmadı: önceki Chromium indirmesi geçersiz arşiv döndürdü ve bulut tarayıcısı yerel sunucuya erişemedi. Kontrollü olaylarla çalışan testler gerçek tarayıcı testi olarak sunulmuyor.

Açık cinsel eylemlere özel seçenek üretimi, hareket/pozisyon sekmeleri, özel panel ve Lust mekaniği geliştirilmedi. Görüntüde olmayan eylemler üretilmedi. Genel kaynak/kimlik/oynatma yardımcıları düzeltildi; bu değişiklikler bütün başlangıç raporunun çözüldüğü anlamına gelmez.

Video URL ve API anahtarı girişleri, altyazı/dublaj kontrolleri ve güncel arayüz kaldırılmadı. Eski ses yamalarından taşınmayan bölümler yeni yayın kapsamında çözülmüş sayılmıyor.

## Yayında gözlenen bağımlılıklar ve ek doğrulama

Genel altyapı düzeltmeleri `c5f9299e0a952b738f2847c7a9b83da1d1f772c8` ile GitHub main'e kaydedildi.
Render `dep-db50th49v7es738kukhg` yayını 10 Ekim 2026 10:10:52 UTC'de canlıya geçti.
Çalışan servisin başlangıç logu aynı commit'i, çalışma kontrolü `ready: true` ve `errors: []` değerlerini doğruladı.
Kabiliyet uç noktalarının yerel servis başlangıç kontrolleri HTTP 200 döndü; bu kontroller gerçek sağlayıcı erişimini doğrulamıyor.
Backend ElevenLabs anahtarı ayarlı değil, tarayıcı anahtarı desteği mevcut; yapılandırma değiştirilmedi.

Bu yayının npm ci logu iki mevcut bağımlılık uyarısı gösterdi. `package-lock.json` içinde yalnızca ilgili paketler uyumlu aralıklarında güncellendi:

- `proxy-addr` 2.0.7 → 2.0.8: [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h).
- `multer` 2.3.0 → 2.4.0: [GHSA-3pph-fpjx-jg34](https://github.com/advisories/GHSA-3pph-fpjx-jg34).

Bu uyarılar uygulamaya saldırı yapıldığı anlamına gelmez. Yeni bağımlılıklar temiz `npm ci` ile kuruldu;
MP3 modülü derlendi; tam test paketi yeniden **1.015/1.015** geçti; `npm audit` bildirilen açık sayısı **0** oldu.
Gerçek yerel HTTP üzerinden oturum açma, diske multipart yükleme ve kontrollü yerel analiz sunucusuna iletme,
bellek yüklemesinde yanlış alanı reddetme, sağlık/sayfa/modül sunumu tekrar doğrulandı. Bu testte sağlayıcı API çağrısı yapılmadı.

Canlı URL'ye doğrudan HTTP kontrolü zaman aşımına uğradı; bulut tarayıcısı önce Render uyanma ekranını gösterdi,
sonraki okuma tarayıcı URL politikası tarafından engellendi. Kısıtlama aşılmaya çalışılmadı.
Bu nedenle yayın sonrası kullanıcı arayüzü/oynatma testi tamamlandı sayılmıyor; yayın durumu ve aktif commit Render API ve servis loglarıyla doğrulanıyor.

Bağımlılık güncellemesinin son commit'i ve Render yayın sonucu son çalışma yanıtında ayrıca bildirilir.
