# Robot görüntüsü üçün promptlar

Promptlar ingiliscədir, çünki şəkil və video alətləri ingilis dilini daha yaxşı başa düşür.

## Addım 1: Şəkil (robot + otaq)

Harada: https://gemini.google.com (şəkil yarat), AI Studio və ya ChatGPT. Ölçü: **9:16 (şaquli)**.

```
Photorealistic vertical smartphone photo, 9:16. A friendly humanoid robot sits at a wooden table
in a cozy, real modern apartment living room in the evening, looking straight into the camera
like a TikTok live streamer.
The robot: matte white and graphite metal head and shoulders, visible joints and screws, slightly
worn and used, two round glowing soft-blue camera eyes, and a horizontal dark mesh speaker grille
as a mouth with a faint blue LED strip behind it. Head and upper torso centered, shot from chest up.
Background: real lived-in room, sofa, warm floor lamp, bookshelf, plant, window with city lights
at night, slight background blur (shallow depth of field).
Lighting: warm lamp light plus soft blue light from the robot's eyes, natural shadows.
Shot on iPhone on a tripod, realistic textures, subtle film grain. No text, no logos, no people.
```

4-5 variant yarat və ən real görünəni seç. Bu şəkil hər iki videonun **ilk kadrı** olacaq.

## Addım 2: Videolar (eyni şəkildən)

Harada: Kling AI, Hailuo (MiniMax), Runway, Pika, Google Flow (Veo) kimi **image-to-video** alətlərində.

Qaydalar:
- Hər iki video **eyni şəkildən** yaradılır.
- Varsa, **"end frame"** (son kadr) yerinə də **eyni şəkli** qoy. Belə olanda video tikişsiz döngü olur.
- Kamera **tamamilə sabit** qalmalıdır: zoom və hərəkət olmasın.
- Uzunluq: 5-10 saniyə. Ölçü: 9:16. Video səssiz olsun və ya səsi sonra silərik.

### idle.mp4 (susur)
```
Static locked-off camera, no camera movement. The robot sits still and idles naturally:
very subtle breathing-like motion of the shoulders, slowly blinks its blue eyes, small slight
head tilt and returns to the starting position. The mouth LED is dim and steady.
Warm lamp light gently flickers. Realistic, calm, seamless loop, ends exactly like the first frame.
```

### talking.mp4 (danışır)
```
Static locked-off camera, no camera movement. The robot is talking to the camera like a live
streamer: small natural head movements and nods, the blue LED strip behind its mouth grille
pulses brightly as if speaking, eyes glow and blink occasionally, slight hand gesture near the
bottom of the frame. Realistic, friendly, seamless loop, ends exactly like the first frame.
```

İstəsən, 2-3 fərqli `talking` videosu da yarat (`talking2.mp4`, `talking3.mp4`). Robot onları növbə ilə işlədər, belə olanda təkrar hiss olunmaz.

## Addım 3: Fayllar
Videoları `media/` qovluğuna qoy:
```
media/idle.mp4
media/talking.mp4
media/talking2.mp4   (istəyə görə)
```
Seçdiyin şəkli də `design/robot.png` kimi saxla.
