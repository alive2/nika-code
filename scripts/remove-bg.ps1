# remove-bg.ps1 — strip the white background (+ soft light shadow) from the
# NikaCode master logo, producing a transparent-background master PNG.
# Fast C# implementation (LockBits + BFS flood fill from the borders).
param(
    [string]$Source = (Join-Path $PSScriptRoot '..\resources\nika\nika-icon.png'),
    [string]$Out    = (Join-Path $PSScriptRoot '..\resources\nika\nika-icon.png'),
    [double]$Tolerance = 42.0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;

public static class BgRemover
{
    public static int Remove(string src, string dst, double tolerance)
    {
        int removed;
        byte[] px;
        bool[] isBg;
        int w, h, stride;
        using (Bitmap bmp = new Bitmap(src))
        {
            w = bmp.Width; h = bmp.Height;
            BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h),
                ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            stride = data.Stride;
            px = new byte[stride * h];
            System.Runtime.InteropServices.Marshal.Copy(data.Scan0, px, 0, px.Length);
            bmp.UnlockBits(data);
        } // dispose source BEFORE saving to the same path

        {
            // background mask via BFS from the borders
            isBg = new bool[w * h];
            Queue<int> queue = new Queue<int>();
            for (int x = 0; x < w; x++)
            {
                if (IsBg(px, stride, x, 0, w, tolerance)) { int i = x; if (!isBg[i]) { isBg[i] = true; queue.Enqueue(i); } }
                if (IsBg(px, stride, x, h - 1, w, tolerance)) { int i = (h - 1) * w + x; if (!isBg[i]) { isBg[i] = true; queue.Enqueue(i); } }
            }
            for (int y = 0; y < h; y++)
            {
                if (IsBg(px, stride, 0, y, w, tolerance)) { int i = y * w; if (!isBg[i]) { isBg[i] = true; queue.Enqueue(i); } }
                if (IsBg(px, stride, w - 1, y, w, tolerance)) { int i = y * w + w - 1; if (!isBg[i]) { isBg[i] = true; queue.Enqueue(i); } }
            }
            int[] dx = { -1, 1, 0, 0 };
            int[] dy = { 0, 0, -1, 1 };
            removed = 0;
            while (queue.Count > 0)
            {
                int i = queue.Dequeue();
                removed++;
                int x = i % w, y = i / w;
                for (int d = 0; d < 4; d++)
                {
                    int nx = x + dx[d], ny = y + dy[d];
                    if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                    int ni = ny * w + nx;
                    if (isBg[ni]) continue;
                    if (IsBg(px, stride, nx, ny, w, tolerance)) { isBg[ni] = true; queue.Enqueue(ni); }
                }
            }

            // build output with alpha
            using (Bitmap outp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                BitmapData od = outp.LockBits(new Rectangle(0, 0, w, h),
                    ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                int ostride = od.Stride;
                byte[] opx = new byte[ostride * h];
                for (int y = 0; y < h; y++)
                {
                    for (int x = 0; x < w; x++)
                    {
                        int i = y * w + x;
                        int si = y * stride + x * 4;
                        byte a = 255;
                        if (isBg[i])
                        {
                            a = 0;
                            // feather: neighbour not bg -> partial alpha
                            for (int d = 0; d < 4 && a != 0; d++)
                            {
                                int nx = x + dx[d], ny = y + dy[d];
                                if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                                if (!isBg[ny * w + nx]) a = 80;
                            }
                        }
                        int oi = y * ostride + x * 4;
                        opx[oi] = px[si]; opx[oi + 1] = px[si + 1]; opx[oi + 2] = px[si + 2]; opx[oi + 3] = a;
                    }
                }
                System.Runtime.InteropServices.Marshal.Copy(opx, 0, od.Scan0, opx.Length);
                outp.UnlockBits(od);
                outp.Save(dst, ImageFormat.Png);
            }
            return removed;
        }
    }

    private static bool IsBg(byte[] px, int stride, int x, int y, int w, double tol)
    {
        int i = y * stride + x * 4;
        int r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
        if (a < 200) return false;
        return (255 - r) < tol && (255 - g) < tol && (255 - b) < tol;
    }
}
'@

$removed = [BgRemover]::Remove((Resolve-Path $Source), (Resolve-Path $Out), $Tolerance)
Write-Output "background pixels removed: $removed"

Add-Type -AssemblyName System.Drawing
$chk = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Out))
$t = 0; $total = 0
for ($x = 0; $x -lt $chk.Width; $x += 5) {
    for ($y = 0; $y -lt $chk.Height; $y += 5) {
        $p = $chk.GetPixel($x, $y); $total++
        if ($p.A -lt 250) { $t++ }
    }
}
Write-Output ("result: {0}x{1}, transparent samples {2}/{3} ({4:P0})" -f $chk.Width, $chk.Height, $t, $total, ($t / $total))
$chk.Dispose()
