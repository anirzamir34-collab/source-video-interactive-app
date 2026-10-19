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

- Yakınlaşma arasındaki konuşma, kaynak zamanı gelince normal panelde açılır;
  ardından "Yakınlaşmaya dön" ile yakınlaşma menüsüne dönülür.
- Hiçbir panelde videoda olmayan bir seçenek üretilmez.

## 2. Lust

- Lust yalnız ilk yakınlaşma görüntüsü oynadıkça dolar; konuşma Lust vermez.
- Dolum hızı gerçek harekete göre: tutkulu/hızlı sahneler sakin/yavaş
  sahnelerden 3–4 kat hızlı doldurur (tempo, ses yoğunluğu, model hareket oranı).
- Yakınlaşma görüntüsü yoksa seks paneli doğrudan açık başlar.
- Lust 100 olunca seks panelindeki **bütün** pozisyon sekmeleri birlikte açılır.

## 3. Seks paneli

- Her pozisyon ailesi tek sekme. Aynı pozisyon videoda birkaç kez geçiyorsa
  ilk dokunuş videonun o anki yerine en yakın geçişi açar; o pozisyon oynarken
  tekrar dokunmak sonraki geçişe gider.
- Uzun bir pozisyon (≈36 sn üstü) birkaç karta bölünür; her kart kendi gerçek
  sekanslarını sırayla oynatır.
- Pozisyon adı vücut düzeninden gelir (kovboy / ters kovboy / doggy / ayakta
  doggy / prone-bone / misyoner ...).
- Panel videonun genişliği boyunca altta; seçenekler kaydırmadan görünür.

## 4. Oynanış akışı

- Seçim beklenirken video durur ve seçenekler görünür kalır; hiçbir durumda
  seçeneksiz donuk ekran olmaz.
- Her analiz sıfırdan yapılır; eski analiz parçaları yeniden kullanılmaz.
- Biten analiz otomatik olarak Kayıtlı oyunlar'a kaydedilir.

## 5. Türkçe dublaj

- Yalnız konuşmalar çevrilir ve seslendirilir. İnleme, nefes, "ah/oh/mmm",
  tekrarlanan "yes", "oh my god" gibi sesler ve tüm arka plan orijinal kalır.
- Kadına kadın, erkeğe erkek sesi; karışık konuşmacı kimlikleri cinsiyete göre ayrılır.
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

## 7. Analiz

- 25 dk ve üstü videolarda önce ucuz bir ön tarama, sonra yalnız yakınlaşma
  ve seks bölümlerinde ayrıntılı analiz.
- Model kısa ve bozuk bir yanıtla bölümü bitirirse o bölüm tekrar
  sorulmaz, boşluk olarak geçilir.
