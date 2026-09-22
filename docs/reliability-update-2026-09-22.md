# Video analizi ve dublaj düzeltmeleri — 22 Eylül 2026

Temel sürüm: `b392003360b05e9ab063d05d8e9aeaf10a1992d9`.

Bu değişiklik genel video bölümleme, dublaj oynatma ve ses önbelleğini kapsar.
Açık cinsel etkileşim, pozisyon sınıflandırması ve orgazm mekanikleri bu
çalışmanın kapsamına alınmadı. Karakter/ilişki korumaları değiştirilmedi.

## Bulgular ve yapılanlar

| Sorun | Neden | Düzeltme |
| --- | --- | --- |
| Uzun video 10 geniş bölümde inceleniyor | Tek bir grup boyutunu yukarı yuvarlamak, hedef bölüm sayısını düşürüyordu. | Dengeli, açık sayfa aralıkları kullanılıyor. 50 dakikalık, 19 sayfalık örnek 19 bölüme ayrılır; uzun video üst sınırı 20'dir. Kısa videolar daha az istek kullanır. |
| Bölüm sınırları boşluk bırakabiliyor | Odaklanmış kareler eşit aralıklı olmadığı halde son kareye ortalama aralık ekleniyordu. | Bir bölümün sonu sonraki bölümün başlangıcıdır; son bölüm gerçek video sonunda biter. Değişen plan eski bölüm önbelleğiyle karıştırılmaz. |
| Önceki cümleyi bekleyen kısa yanıt kayboluyor | Yalnız o anda aktif altyazılar seçiliyor; kısa yanıt beklerken süresi doluyordu. | Önceki sesin kalan süresi yanıtı tüketecekse görüntü bekler. Yanıt ilk heceden başlar. |
| Uzun sesin sonu kesiliyor | Üretilen ses, hızlandırma ve 1,1 saniyelik toleransa sığmayınca durduruluyordu. | Uzun ses için görüntü bekler. Örtüşen diğer konuşmacılar kendi ses konumlarını korur. Seek/eski kaynak tamamlanması otomatik oynatmayı başlatamaz. |
| Dublaj acele ve yapay duyulabiliyor | Süre uyuşmazlığı sesi nominal 1,3× hıza çıkarıyordu. | Nominal uyarlama üst sınırı 1,15×. Küçük saat düzeltmesi ayrı kalır; büyük farklarda görüntü bekler. Bu, öznel ses kalitesinin doğrulandığı anlamına gelmez. |
| Hata sonrası sözcükler yeniden duyulabiliyor | Ses çözücü hatasında duyulmuş örnek konumu unutuluyordu. | Yeniden deneme kaydedilmiş ses konumundan devam eder; açık seek bu kurtarma bilgisini temizler. Takılmış çözücü görünür yeniden deneme kontrolüne geçer. |
| Geciken ilk oynatma cümlenin başını kesebiliyor | 650 ms'den sonra gelen ilk çağrı, kullanıcı seek yapmasa da sesin başını atlıyordu. | Duyulmamış ses yalnız açık kaynak seek işleminde ileri konumdan başlar. |
| Son konuşma bitmeden video/seçim tamamlanıyor | Video sonu ve seçim ekranındaki sabit 8 saniyelik bekleme sesi kesebiliyordu. | Video sonunda başlamış ses tamamlanır. Seçim beklemesi kalan ses süresini ve oynatma hızını hesaba katar. |
| Aynı kısa yanıt her sahnede aynı MP3 | Önbellek yalnız metin, hesap, ses ve ayarlara göre eşleşiyordu. | Kaynak replik kimliği/zamanı, özgün metin, komşu diyalog ve duygu önbellek anahtarına katılır. Aynı isteğin tekrarı yine önbelleği kullanır. Bağlam seslendirilecek metne eklenmez. |

İkinci kontrol yeni kare çıkarmaz; hazır görseller üzerinden belirsiz bulguları
doğrular. İlerleme metni bunu açıklar. Başarılı ilk kontrol, ikinci kontrol
yeniden denenirken korunur. İnceleme gereklilikleri kaldırılmadı.

Normal diyaloglarda doğrulanmış rollerin tam kişi çiftiyle eşleştirilmesi,
ters ilişki kanıtı, grup sahnelerinde belirsizlik ve eski rolün temizlenmesi
mevcut testlerde doğrulandı. Bu alanda yeni bir hata yeniden üretilemedi.

## Doğrulama ve sınırlar

- Bölümleme ve ses kaybı regresyonları düzeltmeden önce başarısız oldu.
- Son `npm test`: 536 geçti, 0 başarısız, 0 atlandı.
- `git diff --check` temiz. Bağımlılık ve ortam değişkenleri değiştirilmedi.
- Testler gerçek uygulama işlevlerini kontrollü medya olayları ve sahte
  sağlayıcı yanıtlarıyla çalıştırır. Gerçek kaynak ses/ElevenLabs çıktısı
  dinlenmedi; Türkçe telaffuz, oyuncunun tınısı ve duygu eşleşmesi doğrulanmadı.
- Sistem Gemini ile çeviri, atanmış ElevenLabs sesiyle metinden ses üretimi
  yapar. Bu yol kaynak oyuncunun sesini akustik olarak kopyalamaz.
- Yeni bağlam anahtarı farklı repliklerde daha fazla TTS üretimi gerektirebilir.
  Daha fazla analiz bölümü de toplam sürenin kesin kısalacağını garanti etmez.
- Kare sayısı artırılmadı. Seyrek örnekler arasındaki kısa olaylar yine
  kaçabilir; bütün video kare kare analiz ediliyor iddiası yapılmamalıdır.
- Eski kayıtlardaki MP3'ler korunur. Oynatıcı düzeltmeleri sayfa yenilendiğinde
  uygulanır; yeni sentez/önbellek davranışını denemek için yeni dublaj gerekir.

ElevenLabs'in [ses üretim API'si](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
ve [seslendirme önerileri](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)
kontrol edildi. Mevcut Natural/Robust seçimi korundu; rastgele oyunculuk,
ek soluk/gülme sesleri veya v3 için SSML durakları eklenmedi.
