import sys
from PIL import Image, ImageOps

def crop_icon():
    img = Image.open('/tmp/raw_icon2.png')
    
    # Convert to RGBA if not already
    img = img.convert("RGBA")
    
    # Get the bounding box of the non-transparent alpha channel
    bbox = img.getbbox()
    if bbox:
        cropped = img.crop(bbox)
        
        # Now make it a square by padding with transparent background
        # We will use a multiplier to ensure it doesn't look "too zoomed in"
        major_axis = max(cropped.width, cropped.height)
        
        # 1.1 multiplier gives a very slight margin so it looks big but has safe bounds
        canvas_size = int(major_axis * 1.1)
        
        new_img = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))
        
        # Center it
        paste_x = (canvas_size - cropped.width) // 2
        paste_y = (canvas_size - cropped.height) // 2
        new_img.paste(cropped, (paste_x, paste_y))
        
        # Resize to standard favicon size, e.g. 512x512
        final_img = new_img.resize((512, 512), Image.Resampling.LANCZOS)
        
        # Save as PNG
        final_img.save("public/favicon.png", format="PNG")
        print("Successfully created properly padded favicon.png")
    else:
        print("Image was empty or bounding box not found")

if __name__ == "__main__":
    crop_icon()
