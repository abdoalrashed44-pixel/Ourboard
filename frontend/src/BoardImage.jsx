import { useEffect, useState } from 'react';
import { Image } from 'react-konva';

// Draws a picture shape on the canvas. Konva can only draw a picture the browser has
// already loaded, so this loads the shape's src first, and draws an empty box (which can
// still be clicked and dragged) until it's ready. Everything else — position, size,
// selection, the ref the resize handles attach to — is passed straight through to Konva
function BoardImage({ src, ...props }) {
  const [picture, setPicture] = useState(null);

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => setPicture(img);
    img.src = src;
    // If the shape disappears before its picture finishes loading, don't update anything
    return () => {
      img.onload = null;
    };
  }, [src]);

  return <Image image={picture} {...props} />;
}

export default BoardImage;
