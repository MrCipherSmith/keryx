export interface TestimonialProps {
  quote: string;
  author: string;
}

export function Testimonial({ quote, author }: TestimonialProps) {
  return (
    <figure className="rounded-2xl bg-white p-6 shadow-lg">
      <blockquote className="text-lg text-slate-700">“{quote}”</blockquote>
      <figcaption className="mt-3 text-sm font-semibold text-slate-500">{author}</figcaption>
    </figure>
  );
}
