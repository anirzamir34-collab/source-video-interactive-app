# VideoQuest oyun kuralları

Bu dosya oyunun nasıl davranması gerektiğinin tek kaynağıdır. Bir düzeltme bu
kurallardan birini değiştiriyorsa önce bu dosya güncellenir, sonra kod ve
testler. `test/analysis-fixtures.test.js` gerçek analizlerle bu kuralları
otomatik kontrol eder.

## 1. Üç ayrı panel

| Panel | Ne girer | Ne girmez |
|---|---|---|
| Normal seçenekler | Konuşmalar, hikâye olayları, sahne geçişleri, yakınlaşma öncesi ve arası konuşmalar | Lust, dokunma, seks |
| İlk yakınlaşma (Lust) | Dokunma, masaj, öpüşme, sarılma, soyunma ve ilk seks pozisyonundan önceki oral/manuel | Konuşma kartları, seks pozisyonları |
| Seks paneli | Pozisyon sekmeleri ve her pozisyonun gerçek hareket kartları; ilk pozisyondan sonra tekrar gelen oral kendi sekmesinde | Uydurma seçenek, yanlış sahne |

- Yakınlaşma paneli ilk dokunma/öpüşme/soyunma/oral anında başlar; ondan
  önceki konuşma ve hikâye normal panelde sırayla oynar.
- Yakınlaşma arasındaki konuşma, kaynak zamanı gelince normal panelde açılır;
  ardından "Yakınlaşmaya dön" ile yakınlaşma menüsüne dönülür.
- İlk yakınlaşma menüsü aynı anda en çok 4 seçenek gösterir, zaman sırasıyla;
  oynanan seçenek menüden çıkar. Uzun açılışlarda kartlar arasında en az 8 sn
  bulunur; bir kart, az önce oynanan klibin bittiği yerden başlamaz. Menünün üstünde canlı Lust göstergesi vardır.
- Hiçbir panelde videoda olmayan bir seçenek üretilmez.

## 2. Lust

- Lust yalnız ilk yakınlaşma görüntüsü oynadıkça dolar; konuşma Lust vermez.
- Dolum hızı gerçek harekete göre: tutkulu/hızlı sahneler sakin/yavaş
  sahnelerden 3–4 kat hızlı doldurur (tempo, ses yoğunluğu, model hareket oranı).
- Lust 100 için yaklaşık 1 dakikalık ağırlıklı görüntü yeter (birkaç sakin
  klip ya da daha az yoğun klip); uzun açılış dakikalarca beklemez.
- Yakınlaşma görüntüsü yoksa seks paneli doğrudan açık başlar.
- Lust 100 olunca seks panelindeki **bütün** pozisyon sekmeleri birlikte açılır.

## 3. Seks paneli

- Her pozisyon ailesi tek sekme. Aynı pozisyon videoda birkaç kez geçiyorsa
  ilk dokunuş videonun o anki yerine en yakın geçişi açar; o pozisyon oynarken
  tekrar dokunmak sonraki geçişe gider.
- Uzun bir hareket (16 sn üstü) ~9 sn'lik ardışık gerçek sekanslara bölünür;
  karta bir dokunuş bu sekansların hepsini kesintisiz oynatır, son sekanstan
  sonra yeni seçim beklenir.
- Oral temas (ağız-genital) her zaman Oral sekmesidir; görünür penetrasyon
  olmadan kovboy/ters kovboy gibi bir pozisyon adı verilmez.
- Kart yazısı o aralıkta gerçekten görünen hareketi söyler (bacaklarını kaldır,
  ters çevir...); görünür bir değişim yeni kart/sekans başlatır.
- Pozisyon adı vücut düzeninden gelir (kovboy / ters kovboy / doggy / ayakta
  doggy / prone-bone / misyoner ...).
- Panel videonun genişliği boyunca altta; seçenekler kaydırmadan görünür.
- SEKS butonu: bir pozisyon açıkken panelin sağ altında durur. Dokunmak aynı
  pozisyonun sıradaki daha yoğun gerçek kesitine (yoksa sıradaki kesite) geçer;
  basılı tutup bırakmak o pozisyonda kalan en yoğun ana atlar. Kesit kalmayınca gizlenir.

## 4. Oynanış akışı

- Seçim beklenirken video durur ve seçenekler görünür kalır; hiçbir durumda
  seçeneksiz donuk ekran olmaz.
- Oyun girişteki logo/reklam/başlık ekranlarını ve ilk olaydan önceki boş
  görüntüyü atlayarak başlar; sondaki kapanış, jenerik ve fragman ekranlarından
  önce "Video tamamlandı" ile biter. Bu ekranlar seçenek olarak gösterilmez.
- Her analiz sıfırdan yapılır; eski analiz parçaları yeniden kullanılmaz.
- Biten analiz otomatik olarak Kayıtlı oyunlar'a kaydedilir.

## 4b. Hissiyat

- Varsayılan sakin: her seçimde tek, yumuşak bir dokunuş. Basarken titreşim yok.
- Yalnız hızlı/yoğun gerçek hareket kartında (ve SEKS butonunda) 2–3 vuruşluk
  kısa ritim ve sahne kenarında nabız gelir.
- Lust %50'de tek yumuşak kalp atışı, 100'de bir kez uzun titreşim.
- Titreşim gücü, titreşimin açık kalma süresiyle ayarlanır (PWM). Hareketi azaltma
  ayarı açık cihazda animasyonlar kapanır.

## 5. Türkçe dublaj

- Yalnız konuşmalar çevrilir ve seslendirilir. İnleme, nefes, "ah/oh/mmm",
  tekrarlanan "yes", "oh my god" gibi sesler ve tüm arka plan orijinal kalır.
- Kadına kadın, erkeğe erkek sesi; karışık konuşmacı kimlikleri cinsiyete göre ayrılır.
- Otomatik cinsiyet yanlış algılanırsa "Sesleri düzenle"de elle seçilen ses geçerlidir;
  elle seçim yüzünden dublaj iptal olmaz.
- Süresine sığmayan cümle önce kısaltılır, sonra en çok 1,35× hızlandırılır;
  yine sığmazsa o cümle orijinal seste kalır. İş yalnız hiçbir cümle
  seslendirilemezse iptal olur.
- ElevenLabs'a aynı anda en çok 2 ses isteği gider; "çok fazla eşzamanlı
  istek" cevabında iş iptal olmaz, yer açılması beklenir.

## 6. Etiketler ve karakterler

- Seçenekler videodaki adlarla, ad yoksa hikâye rolüyle (komşu, patron...),
  o da yoksa sabit görünüş tarifiyle yazılır; "Partner A" en son çare.
- Aile / üvey aile ilişkisi normal hikâye seçeneklerinde kalabilir; ilk
  yakınlaşma ve seks paneli seçeneklerine aktarılmaz.

## 6b. Baş karakter ve grup sahneleri

- Analizden önce yazılan tarif baş karakteri belirler; tarif yoksa videoda en
  çok görünen ve hikâyeyi yürüten erkek (POV kamera sahibi dahil) seçilir ve
  video boyunca aynı kişi kalır.
- Bütün seçenekler baş karaktere göre kurulur. Başka bir erkeğin sahnesinde
  "Bölümü izle" / "Sahneyi geç" çıkar; izlerken de "Sahneyi geç" ekranda kalır.
- Grup sahnesinde baş karakter kadınlar arasında geçiş yapsa da kesintisiz
  devam eden karşılaşma tek sahnedir: yakınlaşma ve Lust bir kez, en başta
  oynanır; Lust 100 olunca iki partnerin bütün pozisyonları açılır. İki ayrı
  çift sahnesi (grup değil) ayrı kalır.
- Baş karakter ile diğer erkek aynı sahnedeyse seçenekler yalnız baş karakterin
  kendi hareketlerinden oluşur.
- Baş karakterin karısı olduğu doğrulanmışsa yakın sahne seçeneklerinde "karın"
  diye anılır; başka birinin eşi ya da tahmin bunu açmaz.

## 7. Analiz

- 25 dk ve üstü videolarda önce ucuz bir ön tarama, sonra yalnız yakınlaşma
  ve seks bölümlerinde ayrıntılı analiz.
- "Video ile analiz (deneysel)" seçilirse telefon videonun küçük bir analiz
  kopyasını çıkarır (480 px, saniyede 4 kare, sesli; H.264 yoksa WebM), sunucu
  onu Google'a verir ve Gemini her bölümün videosunu sesiyle izler (saniyede 2
  kare, düşük çözünürlük). Herhangi bir adım başarısız olursa analiz otomatik
  olarak resimli yöntemle devam eder. 25 dakikayı aşan videolarda video yalnız
  ayrıntılı (yakın sahne) bölümlerinde kullanılır; ön taramanın ucuz hikâye
  bölümleri resimle analiz edilmeye devam eder.
- Google bir bölümü bütün modellerde içerik nedeniyle reddedebilir; bu
  durumda o aralık analizsiz oynatılır, uygulama bunu aşamaz.
- Analiz edilemeyen bölüm istenen modelle yeniden denenebilir; aynı model aynı
  bölümü iki kez reddederse o model için durur.
- Analiz talimatı lib/analysis-prompt.js içindedir; her kural tek yerde ve
  konu başlıkları altında durur. Eski uzun talimat lib/analysis-prompt-legacy.js
  içinde saklıdır; Render'da ANALYSIS_PROMPT=legacy ayarıyla geri dönülür.
- Model kısa ve bozuk bir yanıtla bölümü bitirirse o bölüm tekrar
  sorulmaz, boşluk olarak geçilir.

## Videoyu kesme (uzun videolar)
- Video seçildikten sonra (dosya ya da bağlantı) "Videoyu kes" alanında başlangıç/bitiş (dk:sn) yazılır veya önizlemede "Şu an" ile alınır.
- Kesme telefonda, yeniden kodlamadan yapılır (mediabunny, `trimVideo` — public/video-proxy.js); başlangıç en yakın anahtar kareye kadar birkaç saniye geriye kayabilir.
- Kesilen dosya seçili videonun yerine geçer: kareler, ses, video modu, oynatma ve kayıtlı oyun bu kısa videoyu kullanır. "Videonun tamamına dön" orijinali geri getirir.

## Hareket kartları, tempo düğmeleri ve sekanslar
- Uzun pozisyonlar ve uzun yakınlaşma klipleri (öpüşme, okşama, oral) 10–20 saniyelik sekanslara bölünür; her dokunuş aynı kartın henüz izlenmemiş sıradaki sekansını oynatır.
- Kart = erkeğin o anki gerçek hareketi ("Saçını tutarak devam et"). Kartın altındaki **Hızlan / Sertleş / Derine / Yavaşla** düğmeleri aynı hareketin videoda gerçekten hızlandığı/sertleştiği/derinleştiği/yavaşladığı parçaları oynatır; videoda o tempo yoksa düğme çıkmaz (public/movement-tempo.js).
- Analiz talimatı uzun aksiyonlar için 10–20 sn'lik `verifiedSubsequences` ve her parçaya `movementChange` (faster/slower/harder/deeper/none) ister.

## Pozisyon açılışı (Lust)
- En fazla 3 pozisyon: ilk dolu Lust 1 pozisyon açar, sonra her dolu Lust bir tane daha.
- 4–5 pozisyon: ilk açılışta 2; 6+: ilk açılışta 3; kalanlar her dolu Lust'ta birer birer.
- Kilitli pozisyonlar gri ve kilitli sekme olarak görünür. Video doğal akışla kilitli bir pozisyonun görüntüsüne gelirse o pozisyon kendiliğinden açılır.

## Ödül sahneleri
- Analiz `rewardMoments` döndürür: `her_climax` (kadının görünür zirvesi) ve `highlight` (sahnenin en çarpıcı, final olmayan anı); hepsi gerçek ve doğrulanmış aralıklardır (public/reward-moments.js).
- Kadının zirvesi: seks paneli açıldıktan sonra Lust bir kez daha dolunca "🎁 ÖDÜL AÇILDI" kartı çıkar.
- Videoda kadın zirvesi yoksa: Lust 3 kez dolunca highlight ödülü çıkar. Eski analizlerde highlight, sahnenin en yoğun gerçek hareket klibinden seçilir.
- Erkeğin göstergesi dolunca doğrulanmış final oynar ve "ÖDÜL" bandı görünür.
- Ödül izlendikten sonra oyun kalınan yere döner. "Sonra" ödülü küçük bir 🎁 düğmesi olarak saklar.

## Ölçülen yoğunluk (hareket + nefes/inilti)
- public/intensity-engine.js videonun her saniyesi için gerçek yoğunluğu hesaplar: storyboard'un kareler arası hareket ölçümü (motionProfile) + ElevenLabs dökümündeki inilti/nefes/soluma olayları ve yalnızca ses olan kısa satırlar ("ahh", "mmm").
- Analiz bir pozisyonun bütün parçalarına "orta tempo" dediyse, aynı pozisyonda gerçekten daha hızlı/yavaş hareket eden parçalar ölçümle **Hızlan / Yavaşla** düğmesi alır. Analizin açık hızlı/yavaş kararı önceliklidir.
- Lust ve erkek göstergesi gerçek yoğunluğa göre 0.7×–1.5× hızla dolar.
- Titreşim sakin kalır: yalnızca en yoğun anlarda (hızlı hareket + inilti/nefes) en fazla 1.6 sn'de bir kısa kalp atışı. İnilti duyulurken Lust rozeti hafifçe "nefes alır".
- "En ateşli an" ödülü ölçülen en yoğun gerçek parçadan seçilir.
- Analiz talimatı her 10–20 sn parçaya kendi görünür detay etiketini (saçını tutarak, kalçasını kavrayarak, bacağını omzuna alarak...) ve ses yoğunluğunu ister; genel "devam et" ancak detay yoksa kullanılır.
- "Kucağında" ifadesi, kanıtlı bir kovboy pozisyonunu artık "oturarak" pozisyonuyla çakışma saymaz (sahnenin sonu ve zirve kaybolmuyordu).
