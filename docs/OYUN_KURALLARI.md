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
- Baş karakter ile diğer erkek aynı sahnedeyse seçenekler yalnız baş karakterin
  kendi hareketlerinden oluşur.
- Baş karakterin karısı olduğu doğrulanmışsa yakın sahne seçeneklerinde "karın"
  diye anılır; başka birinin eşi ya da tahmin bunu açmaz.

## 7. Analiz

- 25 dk ve üstü videolarda önce ucuz bir ön tarama, sonra yalnız yakınlaşma
  ve seks bölümlerinde ayrıntılı analiz.
- Google bir bölümü bütün modellerde içerik nedeniyle reddedebilir; bu
  durumda o aralık analizsiz oynatılır, uygulama bunu aşamaz.
- Analiz edilemeyen bölüm istenen modelle yeniden denenebilir; aynı model aynı
  bölümü iki kez reddederse o model için durur.
- Analiz talimatı lib/analysis-prompt.js içindedir; her kural tek yerde ve
  konu başlıkları altında durur. Eski uzun talimat lib/analysis-prompt-legacy.js
  içinde saklıdır; Render'da ANALYSIS_PROMPT=legacy ayarıyla geri dönülür.
- Model kısa ve bozuk bir yanıtla bölümü bitirirse o bölüm tekrar
  sorulmaz, boşluk olarak geçilir.
