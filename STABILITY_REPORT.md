# Uygulama kararlılık incelemesi

Tarih: 18 Eylül 2026. İnceleme; sunucu, yükleme, kaynak çözümleme, video aktarımı, tarayıcı görevleri, analiz kurtarma, altyazı/dublaj ve mevcut oynatıcı regresyonlarını kapsar.

**Sonuç:** Aşağıdaki doğrulanabilir kararlılık sorunlarına düzeltmeler uygulandı. Düzeltmeler geliştirme kopyasında hazırdır; bu çalışma sırasında yeni canlı dağıtım yapılmadı. Hiçbir test sonucu uygulamanın bütün cihazlarda veya bütün kaynaklarda hatasız çalışacağını garanti etmez.

## Bulgular ve uygulanan düzeltmeler

| Öncelik | Bulgu ve etkisi | Düzeltme ve doğrulama |
|---|---|---|
| Yüksek | Aynı yükleme parçasının eşzamanlı tekrarları, ilk yazım tamamlanmadan kontrolü geçerek dosyayı iki kez büyütebiliyordu. | Oturum yazım kilidi eklendi. Çakışan istek yeniden denenebilir 409 alır; tamamlanmış tekrarlar başarıyla karşılanır. Kısmi disk yazımı hata verirse dosya önceki boyuta döndürülür. Gerçek geçici dosya üzerinde eşzamanlılık ve hata testleri geçti. |
| Yüksek | Sağlık kontrolü veya mod değişikliği analiz düğmesini işlem sürerken açabiliyordu. Başlangıç aşamasındaki hata da kontrolleri kilitli bırakabiliyordu. | Analiz ve URL içe aktarımı için işlem kilitleri eklendi; başlangıç kurulumu da try/finally içine alındı. Yinelenen başlatma ve erken hata senaryoları test edildi. |
| Yüksek | Eski video için bekleyen dublaj yanıtı, yeni videonun aynı kimlikli sesini veya istek kaydını değiştirebiliyordu. Eski kota hatası yeni oturumu kapatabiliyordu. | Kaynağa ait iptal denetleyicisi ve güncellik kontrolleri eklendi. Kuyruktaki eski işler çalışmaz; eski yanıt yeni önbelleğe veya arayüze yazamaz. Başarı, kota hatası ve yinelenen kimlik senaryoları geçti. |
| Yüksek | Video proxy yanıt gelmeden süresiz bekleyebiliyor; bağlantı kapanınca üst kaynağın isteği açık kalabiliyordu. HLS işlemi gelen GET isteğinin kapanmasına bağlanmıştı. | Başlık bekleme ve hareketsizlik sınırları, yanıt kapanmasına bağlı iptal ve HLS süreç temizliği eklendi. Range yanıtının durum/başlık/verisi korunuyor. İptaller ile gerçek kaynak hataları ayrı ele alınıyor. |
| Yüksek | Harici analiz yüklemesi dosyanın tamamını RAM'de tutuyor ve Blob oluştururken ek bellek baskısı yaratıyordu. | Bu uç geçici disk dosyasından aktarım yapıyor; başarı/hata sonunda dosyayı siliyor. İstemci bağlantısı kapanınca üst istek iptal ediliyor. Aktarılan içerik ve dosya temizliği test edildi. Bellek yük testi yapılmadı. |
| Orta | Kaynak değişiminde eski zaman sınırı dinleyicisi ve analiz durumu kalabiliyordu. Başarısız URL çözümlemesi mevcut seçimi de siliyordu. | Yeni kaynak uygulanırken eski dinleyici, analiz ve ses oturumu temizleniyor. URL çözümlemesi başarısızsa önceki dosya/analiz korunuyor. Aynı anda iki içe aktarma başlatılamıyor. |
| Orta | Engellenmiş tarayıcı depolaması açılışı durdurabiliyordu. Bozuk yüzde kodlaması içeren çerez giriş ekranında hata üretebiliyordu. | Depolama temizliği hataya dayanıklı hale getirildi; bozuk çerez boş/geçersiz oturum kabul ediliyor. Birim ve gerçek HTTP testleri geçti. |
| Orta | Bazı yükleme hataları JSON yerine HTML dönüyordu; bilinmeyen API adresi uygulama HTML'ini 200 ile döndürebiliyordu. | API 404 ve merkezi JSON hata yanıtları eklendi. Bozuk JSON 400, boyut aşımı 413, desteklenmeyen biçim 415 verir. Geç aşamadaki Multer/raw-parser hataları gerçek HTTP üzerinde test edildi. |
| Orta | Tam video indirmesinde boyut ve hareketsizlik sınırı yoktu. Bozuk URL dosya adı da çözümlemeyi kesebiliyordu. | Başlıkta ve alınan veri toplamında 600 MiB sınırı, 45 saniyelik hareketsizlik iptali ve güvenli ad çözümleme eklendi. Başlıksız büyük veri ve normal indirme testleri geçti. |
| Orta | Dublaj arayüzü Azure/Gemini durumunu hazır gösterebildiği halde oynatıcı ElevenLabs kullanıyordu. Ses sağlayıcı isteklerinin bir kısmı süresiz bekleyebiliyordu. | Sağlayıcı bilgisi düzeltildi; ElevenLabs anahtarı eksikse analizin başında açıklama veriliyor. Sağlayıcı isteklerine süre sınırı eklendi. Uzun hız sınırı beklemelerinde kuyruk tutulmuyor ve sağlayıcının belirttiği süre boyunca yeniden istek gönderilmiyor. |
| Orta | package.json içindeki youtube-dl-exec, kilit dosyasında eksikti; temiz kurulum tekrarlanabilir değildi. README mevcut Gemini/dublaj mimarisini yanlış anlatıyordu. | Kilit dosyası eşitlendi, temiz npm ci tamamlandı. Node alt sınırı kullanılan iptal API'sine uygun olarak 20.3.0 oldu; README gerçek akış ve sınırlarla güncellendi. |

## Test kanıtı

Doğrulama ortamı: Linux, Node.js 24.19.0.

| Kontrol | Sonuç |
|---|---|
| Mevcut analiz, kurtarma, zaman çizelgesi ve oynatıcı regresyonları | 158 geçti |
| Yeni sunucu hata/aktarım testleri | 15 geçti |
| Yeni istemci görev/oturum/indirme testleri | 17 geçti |
| Gerçek HTTP entegrasyonu | 6 alt kontrol ve kapsayıcı test geçti; Node toplamında 7 |
| Toplam npm test | 197 geçti, 0 başarısız |
| Sözdizimi denetimleri | Geçti |
| Temiz bağımlılık kurulumu | npm ci başarılı |
| Değişiklik biçim kontrolü | git diff --check başarılı |
| Görsel tarayıcı kontrolü | Çalıştırılamadı: Playwright'ın Chromium yürütülebilir dosyası ortamda yok |

Sunucu birim testleri gerçek Node akışları ve geçici dosyalar kullanır; üst sağlayıcılar ve HLS alt süreci simüle edilir. HTTP entegrasyonu gerçek Express, body-parser ve Multer ile ayrı bir yerel sunucuda çalışır. İstemci testleri üretim fonksiyonlarını kontrollü DOM/medya benzetimiyle çalıştırır. Ücretli analiz/ses çağrısı veya gerçek Android uçtan uca testi yapılmadı.

## Canlı günlük gözlemi

Mevcut canlı sürümün yayınından önce, 18 Eylül 2026 05:53–06:11 UTC aralığından dönen kayıtlarda tekrarlanan `Video proxy stream error: terminated` satırları vardı. Bu kayıtlar tek başına kesin kök neden kanıtı değildir; iptal/bağlantı yaşam döngüsü incelemesini destekler.

Mevcut yayından sonraki 06:48:40–07:01:08 UTC aralığında yapılan hata seviyesi sorgusu boş döndü. Bu kısa aralıkta hata bulunmaması yük altında uzun süreli kararlılık kanıtı sayılmaz. Bu rapordaki yeni düzeltmeler canlıda doğrulanmış değildir.

## Kalan sınırlar

- Gemini/ElevenLabs/Azure erişimi, model kullanılabilirliği, kota ve ağ kesintileri dış bağımlılıklardır. İçerik veya kota nedeniyle reddedilen sonuçlar başarılı analiz gibi gösterilmez.
- Analiz ve yükleme devam bilgisi kalıcı değildir. Sunucu yeniden başlarsa RAM'deki yükleme/URL oturumları kaybolabilir; sayfa yenilenirse sekmedeki analiz önbelleği kaybolur.
- Tarayıcı tam indirme ve ses çözümleme işlemleri hâlâ bellek kullanır. 600 MiB üst sınırı düşük bellekli bir telefon için güvenli bellek bütçesi garantisi değildir. Uzun video ve arka plana alınma davranışı gerçek cihazda ayrıca doğrulanmalıdır.
- HLS süreç temizliği test edildi; gerçek uzak HLS kaynağı ve bütün kodeklerle dönüşüm testi yapılmadı. Proxy uzun süreli yük ve eşzamanlı kullanıcı testinden geçmedi.
- URL giriş doğrulaması ve HLS protokol kısıtı tam bir ağ izolasyonu sağlamaz. DNS değişimleri ve HLS içindeki alt kaynakların özel ağ erişimi bakımından ayrıca değerlendirilmesi gerekir; bu çalışma kapsamlı bir sızma testi değildir.
- Azure ses uçları mevcut olsa da oynatıcıya Azure sağlayıcı seçimi eklenmedi. Arayüz artık bu sınırı açıkça belirtir.

Canlı yayın öncesindeki kalan kabul kontrolü; gerçek cihazda kısa bir genel amaçlı video ile dosya seçimi, URL içe aktarma, kesinti sonrası yeniden deneme, altyazı/dublaj ve uzun oynatma akışlarının denenmesidir.
