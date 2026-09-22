# Dublaj incelemesi — 22 Eylül 2026

İncelenen temel sürüm: `5a33d72b5dfc4311fbc979d177c79f393b4ee4b3`.
Önceki değişiklik: `e35cf1639a80abe15e615bf5e508cb2c67d2ef19`.

`e35cf16`, aynı konuşmacının altyazı parçalarını birleştirmeyi açmış, ASR
gruplamasının üst sınırını 7 saniyeden 16 saniyeye ve ses sonu toleransını
0,55 saniyeden 1,1 saniyeye çıkarmış. `5a33d72`, tahmine dayalı metin
düzeltmelerini ve otomatik oyunculuk etiketlerini kaldırmış; saat sapmasında
sesi durdurma/atlatmayı kaldırmış; en fazla dört sözcüklü TTS isteklerinde
`stability: 1`, diğerlerinde `0.5` kullanmış.

Bu inceleme kod davranışını doğrular. Gerçek kaynak diyalog ve ElevenLabs
çıktısıyla dinleme yapılmadı; ücretli sağlayıcı çağrısı yapılmadı. Doğallık,
Türkçe telaffuz ve kaynaktaki kişiyle ses benzerliği doğrulanmış değildir.

## Yamaya alınan bulgular

| Öncelik | Kod yolu / yeniden üretim | Değişiklik |
| --- | --- | --- |
| P1 | `canFinishDubTail`, biten kişinin sınırı yerine `active[0].startTime` kullanıyor. A 1–3 sn, B 1,5–6 sn konuşurken 3,05'te A'nın kalan 0,2 sn sesi kesiliyor. Çok ilerideki bir aktif replik tersine eski sese fazladan süre verebiliyor. | Her ses kendi etkin bitiş sınırını kullanır. Aynı kişinin sonraki repliği bu sınırı daraltabilir. |
| P1 | `syncDubPlayback`, önceki ses için 0,8 sn bekleyen ve hâlâ aktif olan yanıtı `elapsed > 0.65` nedeniyle ortasından başlatıyor. | Kuyruk sonunu bekleyen replikler izlenir ve ilk heceden başlar. Gerçek kaynak seek işlemi bekleme bilgisini temizleyerek doğru ses konumuna geçer. |
| P1 | Videonun doğal bitişinde `pause` ve `ended` olayları, tolerans içindeki son heceyi bile durduruyor. | Zaten çalmakta olan kısa ses sonu tamamlanır; yeni bir replik başlatılmaz. |
| P2 | ASR gruplaması 3,5 sn altındaki tamamlanmış yanıtları birleştiriyor; istemci de noktalama sınırını gözetmeden birleştiriyor. Beş ayrı `Evet.` tek beş sözcüklü isteğe dönüşerek zamanlı durakları ve kısa yanıt ayarını kaybediyor. | Tamamlanmış cümleler ve aynı kısa yanıtın ayrı zamanlı tekrarları korunur. Yarım cümle parçaları birleştirilmeye devam eder. Hiçbir kaynak sözcüğü silinmez. |
| P2 | Ses sonu hesabı kalan süreyi duvar saatiyle, sınırı video saniyesiyle karşılaştırıyor. 0,5× hızda geçerli bir son hece erken reddedilebiliyor. | İki taraf da kaynak video saniyesiyle değerlendirilir. |
| P2 | `buildDubSpeakerRoster`, `confidence: 0` değerini `|| 0.5` ile pozitif kanıt sayıyor. 14 sn'lik sıfır güvenli yanlış etiket, 0,5 sn'lik yüksek güvenli doğru etiketi bastırıyor. | Açık sıfır oy sayılmaz; eksik güven değeri için varsayılan korunur ve sayısal güven 0–1 aralığına alınır. |

## Devam eden sınırlar ve dinleme riskleri

1. **P1 — beklerken zaman aralığı tamamen geçen çok kısa yanıt kaybolabilir.**
   `syncDubPlayback` yalnızca o anda aktif repliklerden seçim yapıyor;
   sona ermiş bir repliği taşıyan bekleme kuyruğu yok. Yerel oynatma
   düzeneğinde A=1–2 sn, B=2–2,35 sn, A'nın TTS süresi=2 sn kullanıldı.
   A'nın ses konumu 1,1 sn iken video 2,01'e getirildi; B bekledi. Video
   2,8'e ilerleyip A bitince B için `plays=0`, `played=false` görüldü.
   Bu yama hâlâ aktif repliğin başını korur; süresi tamamen geçmiş olanı
   geri getirmez. Tam çözüm, kaynak videoyu kısa süre bekletme veya sınırlı
   gecikmiş replik kuyruğu için ayrı bir oynatma kararı gerektirir.

2. **P1 — büyük süre uyuşmazlığı hâlâ ses kesebilir.**
   `naturalDubRate` en çok 1,3× sıkıştırır; `canFinishDubTail` 1,1 kaynak
   saniyesi bütçesini korur. Uzun TTS çıktısı veya büyük decoder gecikmesi
   bu bütçeye sığmazsa `syncDubPlayback` sesi durdurur. Saat düzeltmesinin
   artık seek yapmaması bu sınırı ortadan kaldırmaz. Bu nedenle “son
   heceler hiçbir koşulda kesilmez” iddiası yapılamaz.

3. **P2 — aynı metin aynı sesle aynı kaydı yeniden kullanır.**
   `elevenLabsSynthesize` önbelleği hesap, voiceId, metin, model, biçim ve
   ayarları içerir; kaynak replik bağlamı ve duygu anahtara girmez.
   Aynı kişinin farklı anlardaki `Evet.` yanıtları aynı MP3'ü kullanabilir.
   Bu, fazladan replik üretildiğinin kanıtı değildir; tekdüze tonlama
   riski ve maliyet/doğallık tercihidir. Sırf çeşitlilik için rastgele
   duygu veya oyunculuk etiketi eklenmedi. Tek ASR satırındaki gerçek mi
   hatalı mı olduğu bilinmeyen tekrarlar da metinden tahminle silinmedi.

4. **P2 — ayrı ses tahsisi kaynak kişiyle akustik eşleşme demek değildir.**
   `allocateSpeakerVoices` konuşmacıya ayrı ve sabit voiceId sağlar.
   Seçim, ağırlıklı cinsiyet etiketi ve katalogdaki Türkçe/doğallık
   puanlarıyla yapılır; kaynak sesin tınısı, yaş algısı veya aksanına
   yönelik akustik karşılaştırma yapılmaz. ASR iki kişiyi aynı speakerId
   altında birleştirmişse bu katman onları yeniden ayıramaz. Dört kanalın
   testte ayrı çalması, dört kişinin dinlemede doğal eşleştiğini kanıtlamaz.

5. **P2 — kayıtlı eski sesler yeni sentez ayarlarını kullanmaz.**
   Kayıt açılırken `dialogue`, `dubCache` ve `dubSpeakerVoices` geri yüklenir.
   `ensureDubSegment` önbellekteki MP3'ü doğrudan döndürür; kayıtlı oynatma
   modunda yeniden sentez yapılmaz. Yeni gruplama/ses tahsisi için yeni
   analiz ve dublaj hazırlama gerekir. Eski kayıtların sesleri silinmedi.

Noktalama sınırı sözdizimsel bir yaklaşımdır: ASR noktalama koymazsa veya
bir kısaltmayı cümle sonu gibi yazarsa gruplama hâlâ ideal olmayabilir.
Daha çok bağımsız replik, farklı metinlerde daha fazla TTS isteği oluşturabilir.

## Doğrulama

- Başlangıçta ilgili 74 test geçti.
- 11 regresyon/koruma testi eklendi. 10 yeni senaryo düzeltmeden önce
  başarısızdı; ek seek testi mevcut doğru davranışın korunduğunu gösterdi.
- Düzeltmeden sonra ilgili 85 test geçti.
- Son `npm test`: **519 geçti, 0 başarısız, 0 atlandı**.
- `git diff --check` temiz. Testler Node 24.19.0 üzerinde çalıştırıldı.
- Ortam için npm bağımlılıkları, Python `yt-dlp` ve paket extractor
  kurulumu tamamlandı; bağımlılık manifesti/kilit dosyası değiştirilmedi.
- Sağlayıcı testleri sahte yanıt, oynatma testleri kontrollü medya nesnesi
  kullanır. Gerçek Android decoder/MP3 dinlemesi bu sayılara dahil değildir.

## Gerçek dinleme kabul örnekleri

| Kaynak örneği | Kontrol |
| --- | --- |
| Aynı kişinin beş kısa yanıtı; hem aynı hem farklı duygusal bağlamlar | Replik sayısı ve duraklar kaynakla aynı; yeni sözcük yok; tonlama ayrıca değerlendirilir. |
| Kesintisiz uzun cümle ve ardından kısa karşılık | İlk/son hece kaybı yok; aşırı hızlandırma yok; 350 ms yanıtın kaybolma sınırı özellikle kontrol edilir. |
| Dört farklı kişinin örtüşen konuşması | Sabit voiceId yanında gerçek kaynak kişi eşleşmesi, tını ve Türkçe telaffuz dinlenir. |
| Videonun sonunda bir sözcük; 0,5× / 1× / 2× hızlar | Son ses tamamlanır; eski sahne sesi uzamaz; kullanıcı duraklatması ve seek doğru çalışır. |
| Yeni hazırlanmış dublaj ve eski kayıt | Yeni kuralların gerçekten yeniden üretilmiş seslerle sınandığı doğrulanır. |

Her örnekte kaynak zaman kodu, speakerId, kullanılan voiceId ve duyulan
kusur kaydedilmeli. Dinleme tamamlanmadan “doğallık doğrulandı” olarak
işaretlenmemeli. Bu değişiklik yayınlama veya ana dalı birleştirme içermez.
