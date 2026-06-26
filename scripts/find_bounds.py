from PIL import Image

def analyze_columns():
    img = Image.open("icons.png").convert("RGBA")
    width, height = img.size
    
    # We will analyze column activity per row block
    row_blocks = [
        ("Row 0", 144, 323),
        ("Row 1", 461, 624),
        ("Row 2", 756, 929),
        ("Row 3", 1051, 1202)
    ]
    
    for name, r_top, r_bottom in row_blocks:
        print(f"\n{name} (Y={r_top} to {r_bottom}):")
        col_pixels = []
        for x in range(width):
            count = 0
            for y in range(r_top, r_bottom):
                r, g, b, a = img.getpixel((x, y))
                if a > 30 and (r < 240 or g < 240 or b < 240):
                    count += 1
            col_pixels.append(count)
            
        in_activity = False
        start_x = 0
        for x, count in enumerate(col_pixels):
            if count > 2 and not in_activity:
                in_activity = True
                start_x = x
            elif count <= 2 and in_activity:
                in_activity = False
                print(f"  Col activity: X={start_x} to X={x} (width: {x - start_x})")
        if in_activity:
            print(f"  Col activity: X={start_x} to X={width} (width: {width - start_x})")

analyze_columns()
